import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { db, saveAsset } from '@/utils/db'
import type { Cover } from '@/types/cover'
import type { CatalogAsset } from '@/types/asset'
import type { Postmark } from '@/types/postmark'
import { nextSerialNo, nowIso } from '@/utils/id'

export interface ImagePayload {
  dataUrl: string
  fileName: string
}

/** 合并预览：确认前向整理者展示将要转来的实寄封与戳样图。 */
export interface MergePreview {
  source: Postmark
  target: Postmark
  /** 会把销票关联改指到保留邮戳的实寄封 */
  affectedCovers: Cover[]
  /** 源枚带有的戳样原图 */
  sourceAsset: CatalogAsset | null
  /** 保留枚已有的戳样原图（有则不覆盖） */
  targetAsset: CatalogAsset | null
  /** 合并后保留枚的历史别名（源编号 + 双方既有别名，去重保序） */
  aliasesAfter: string[]
  /** 源枚缩略图是否会被带到保留枚（仅当保留枚缩略图为空时） */
  thumbnailMoves: boolean
}

/** 合并后返回的摘要，供页面提示。 */
export interface MergeResult {
  targetId: number
  affectedCoverIds: number[]
  movedSample: boolean
  aliasesAfter: string[]
}

export const usePostmarkStore = defineStore('postmark', () => {
  const list = ref<Postmark[]>([])
  const loading = ref(false)
  const loaded = ref(false)

  async function load(): Promise<void> {
    loading.value = true
    try {
      list.value = await db.postmarks.orderBy('pmNo').toArray()
      loaded.value = true
    } finally {
      loading.value = false
    }
  }

  /** 生成下一个编目号，如 PM-0007 */
  function nextPmNo(): string {
    return nextSerialNo('PM-', list.value.map((p) => p.pmNo))
  }

  async function create(input: Postmark, image?: ImagePayload | null): Promise<number> {
    const now = nowIso()
    const record: Postmark = {
      ...input,
      pmNo: input.pmNo || nextPmNo(),
      lettering: { ...input.lettering },
      createdAt: now,
      updatedAt: now
    }
    delete record.id
    const id = await db.postmarks.add(record)
    if (image && image.dataUrl) {
      await saveAsset({
        ownerType: 'postmark',
        ownerId: id,
        side: 'sample',
        dataUrl: image.dataUrl,
        fileName: image.fileName,
        updatedAt: now
      })
    }
    await load()
    return id
  }

  async function update(id: number, patch: Partial<Postmark>): Promise<void> {
    await db.postmarks.update(id, { ...patch, updatedAt: nowIso() })
    await load()
  }

  async function remove(id: number): Promise<void> {
    await db.postmarks.delete(id)
    await load()
  }

  /** 合并两个别名数组：保序去重。 */
  function mergeAliases(...lists: string[][]): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    for (const list of lists) {
      for (const no of list ?? []) {
        const key = no.trim()
        if (key && !seen.has(key)) {
          seen.add(key)
          out.push(key)
        }
      }
    }
    return out
  }

  /**
   * 合并预览：列出会转来的实寄封与戳样图，不写库。
   * 源编号会连同双方既有别名一起作为保留枚的历史别名。
   */
  async function previewMerge(sourceId: number, targetId: number): Promise<MergePreview> {
    if (sourceId === targetId) throw new Error('不能合并到自身')
    const [source, target] = await Promise.all([
      db.postmarks.get(sourceId),
      db.postmarks.get(targetId)
    ])
    if (!source) throw new Error('待合并邮戳已不存在')
    if (!target) throw new Error('保留邮戳已不存在')

    const [sourceAssets, targetAssets, covers] = await Promise.all([
      db.assets.where({ ownerType: 'postmark', ownerId: sourceId }).toArray(),
      db.assets.where({ ownerType: 'postmark', ownerId: targetId }).toArray(),
      db.covers.toArray()
    ])

    const aliasesAfter = mergeAliases(target.aliases ?? [], source.aliases ?? [], [source.pmNo])
    return {
      source,
      target,
      affectedCovers: covers.filter((c) => c.cancelPmIds.includes(sourceId)),
      sourceAsset: sourceAssets.find((a) => a.side === 'sample') ?? null,
      targetAsset: targetAssets.find((a) => a.side === 'sample') ?? null,
      aliasesAfter,
      thumbnailMoves: !target.imageDataUrl && !!source.imageDataUrl
    }
  }

  /**
   * 把 sourceId 合并到 targetId（同一事务内完成）：
   * 1. 源编号记为保留枚的历史别名（同一组反复合并仍回到同一枚）；
   * 2. 实寄封的销票关联统一改指保留枚并去重；
   * 3. 保留枚已有戳样不覆盖，空缺位置（原图与缩略图）接住源枚图片；
   * 4. 删除源枚记录与其多余原图。
   */
  async function mergeTo(sourceId: number, targetId: number): Promise<MergeResult> {
    if (sourceId === targetId) throw new Error('不能合并到自身')

    // 延迟引入避免与 coverStore 形成模块加载环
    const { useCoverStore } = await import('./coverStore')

    let result: MergeResult
    await db.transaction(
      'rw',
      db.postmarks,
      db.covers,
      db.assets,
      async () => {
        const source = await db.postmarks.get(sourceId)
        const target = await db.postmarks.get(targetId)
        if (!source || !target) throw new Error('待合并或保留的邮戳不存在')

        const now = nowIso()
        const aliasesAfter = mergeAliases(target.aliases ?? [], source.aliases ?? [], [source.pmNo])

        const [sourceAssets, targetAssets, allCovers] = await Promise.all([
          db.assets.where({ ownerType: 'postmark', ownerId: sourceId }).toArray(),
          db.assets.where({ ownerType: 'postmark', ownerId: targetId }).toArray(),
          db.covers.toArray()
        ])
        const covers = allCovers.filter((c) => c.cancelPmIds.includes(sourceId))
        const sourceAsset = sourceAssets.find((a) => a.side === 'sample') ?? null
        const targetAsset = targetAssets.find((a) => a.side === 'sample') ?? null

        // 保留枚已有戳样不覆盖；原图空缺时接住源枚原图
        let movedSample = false
        if (sourceAsset && !targetAsset) {
          await db.assets.add({
            ownerType: 'postmark',
            ownerId: targetId,
            side: 'sample',
            dataUrl: sourceAsset.dataUrl,
            fileName: sourceAsset.fileName,
            updatedAt: now
          })
          movedSample = true
        }

        // 缩略图同样只补空缺
        const nextThumb = target.imageDataUrl || source.imageDataUrl || ''

        // 实寄封销票关联统一指向保留邮戳，并按封去重
        const affectedCoverIds: number[] = []
        for (const cover of covers) {
          if (typeof cover.id !== 'number') continue
          const nextIds = cover.cancelPmIds.map((id) => (id === sourceId ? targetId : id))
          const deduped = Array.from(new Set(nextIds))
          await db.covers.update(cover.id, { cancelPmIds: deduped, updatedAt: now })
          affectedCoverIds.push(cover.id)
        }

        // 清理源枚的全部原图，再删除源枚档案
        await db.assets.bulkDelete(sourceAssets.map((a) => a.id).filter((v): v is number => typeof v === 'number'))
        await db.postmarks.delete(sourceId)

        await db.postmarks.update(targetId, {
          aliases: aliasesAfter,
          imageDataUrl: nextThumb,
          updatedAt: now
        })

        result = { targetId, affectedCoverIds, movedSample, aliasesAfter }
      }
    )

    // 事务提交后再刷新内存列表
    await Promise.all([load(), useCoverStore().load()])
    return result!
  }

  /** 按当前编目号或历史别名查找保留档案，供「用旧编号也能找到」。 */
  function findByCatalogNo(no: string): Postmark | null {
    const key = no.trim()
    if (!key) return null
    return (
      list.value.find(
        (p) => p.pmNo === key || (p.aliases ?? []).some((alias) => alias === key)
      ) ?? null
    )
  }

  function byId(id: number | null | undefined): Postmark | null {
    if (id == null) return null
    return list.value.find((p) => p.id === id) ?? null
  }

  /** 「编目号 + 局所」短标签，供关联列表与详情页复用 */
  const labelOf = computed(() => {
    return (id: number): string => {
      const pm = byId(id)
      return pm ? `${pm.pmNo} ${pm.office}` : `未登记邮戳 #${id}`
    }
  })

  const total = computed(() => list.value.length)
  const scarceCount = computed(
    () => list.value.filter((p) => p.scarceLevel === '罕见' || p.scarceLevel === '孤品').length
  )

  return {
    list,
    loading,
    loaded,
    total,
    scarceCount,
    load,
    nextPmNo,
    create,
    update,
    remove,
    mergeTo,
    previewMerge,
    findByCatalogNo,
    byId,
    labelOf
  }
})
