import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { db, saveAsset } from '@/utils/db'
import type { Postmark } from '@/types/postmark'
import type { CatalogAsset } from '@/types/asset'
import { nextSerialNo, nowIso } from '@/utils/id'
import { useCoverStore } from './coverStore'

export interface ImagePayload {
  dataUrl: string
  fileName: string
}

/** 合并结果统计，供页面提示使用。 */
export interface MergeResult {
  targetId: number
  /** 销票关联被改写（统一指向保留枚）的实寄封数 */
  transferredCoverCount: number
  /** 新记到保留枚上的历史别名（旧编号） */
  aliasesAdded: string[]
  /** 保留枚原无戳样、本次是否接住了原戳样 */
  sampleTakenOver: boolean
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

  /** 生成下一个编目号，如 PM-0007；历史别名占用的编号也会跳过。 */
  function nextPmNo(): string {
    const used = list.value.flatMap((p) => [p.pmNo, ...(p.aliases ?? [])])
    return nextSerialNo('PM-', used)
  }

  async function create(input: Postmark, image?: ImagePayload | null): Promise<number> {
    const now = nowIso()
    const record: Postmark = {
      ...input,
      pmNo: input.pmNo || nextPmNo(),
      lettering: { ...input.lettering },
      aliases: Array.isArray(input.aliases) ? [...input.aliases] : [],
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

  /** 读取某枚邮戳名下的戳样原图（assets 表），不存在返回 null。 */
  async function loadSampleAsset(ownerId: number): Promise<CatalogAsset | null> {
    const rows = await db.assets.where('ownerId').equals(ownerId).toArray()
    return rows.find((a) => a.ownerType === 'postmark' && a.side === 'sample') ?? null
  }

  /**
   * 把 sourceId 合并到 targetId（「合并到另一枚」）：
   * 1. 实寄封的销票关联统一改写为保留枚，同一封重复关联去重；
   * 2. 原编号（及其更早的历史别名）记为保留枚的历史别名；
   * 3. 保留枚已有戳样则不覆盖；空缺时接住原戳样（缩略图 + 原图）；
   * 4. 删除原邮戳记录。同一组反复合并都汇聚到同一枚（幂等收敛）。
   * 票戳组合与寄递记录所属封不变，因此照旧可查。
   */
  async function mergeInto(sourceId: number, targetId: number): Promise<MergeResult> {
    if (sourceId === targetId) {
      throw new Error('不能合并到邮戳自身')
    }
    const now = nowIso()
    let transferredCoverCount = 0
    let aliasesAdded: string[] = []
    let sampleTakenOver = false

    await db.transaction('rw', db.postmarks, db.covers, db.assets, async () => {
      const source = await db.postmarks.get(sourceId)
      const target = await db.postmarks.get(targetId)
      if (!source || !target) throw new Error('待合并的邮戳记录不存在，无法合并')

      // 1. 实寄封销票关联统一指向保留枚，并去掉同封上的重复指向
      await db.covers.toCollection().modify((cover) => {
        if (!Array.isArray(cover.cancelPmIds) || !cover.cancelPmIds.includes(sourceId)) return
        const next = cover.cancelPmIds.filter((id) => id !== sourceId)
        if (!next.includes(targetId)) next.push(targetId)
        cover.cancelPmIds = next
        cover.updatedAt = now
        transferredCoverCount += 1
      })

      // 2. 原编号与更早的旧编号一并记为保留枚的历史别名
      const merged = new Set<string>(target.aliases ?? [])
      const incoming = [source.pmNo, ...(source.aliases ?? [])].filter(
        (no) => !!no && no !== target.pmNo && !merged.has(no)
      )
      incoming.forEach((no) => merged.add(no))
      aliasesAdded = incoming

      // 3. 戳样：保留枚已有（缩略图或原图任一）则不覆盖；空缺才接住原图
      const sourceAssets = (
        await db.assets.where('ownerId').equals(sourceId).toArray()
      ).filter((a) => a.ownerType === 'postmark')
      const sourceSample = sourceAssets.find((a) => a.side === 'sample')
      const targetSample = await loadSampleAsset(targetId)
      const targetHasSample = !!(target.imageDataUrl && target.imageDataUrl.trim()) || !!targetSample

      const movedAssetIds = new Set<number>()
      if (!targetHasSample) {
        const patch: Partial<Postmark> = {
          aliases: [...merged],
          updatedAt: now
        }
        // 缩略图与原图都接住：原图优先作为展示来源，缺缩略图时用原图回填
        if (sourceSample) {
          patch.imageDataUrl = source.imageDataUrl?.trim() ? source.imageDataUrl : sourceSample.dataUrl
        } else if (source.imageDataUrl && source.imageDataUrl.trim()) {
          patch.imageDataUrl = source.imageDataUrl
        }
        if (source.imageDataUrl?.trim() || sourceSample) sampleTakenOver = true
        if (sourceSample && typeof sourceSample.id === 'number') {
          await db.assets.update(sourceSample.id, { ownerId: targetId, updatedAt: now })
          movedAssetIds.add(sourceSample.id)
        }
        await db.postmarks.update(targetId, patch)
      } else {
        await db.postmarks.update(targetId, { aliases: [...merged], updatedAt: now })
      }

      // 清理原编号名下剩余的原图（戳样未被接住时随之清理；封图属于封，不在此列）
      const leftoverIds = sourceAssets
        .map((a) => a.id)
        .filter((id): id is number => typeof id === 'number' && !movedAssetIds.has(id))
      if (leftoverIds.length) await db.assets.bulkDelete(leftoverIds)

      // 4. 删除原邮戳记录
      await db.postmarks.delete(sourceId)
    })

    await Promise.all([load(), useCoverStore().load()])
    return { targetId, transferredCoverCount, aliasesAdded, sampleTakenOver }
  }

  function byId(id: number | null | undefined): Postmark | null {
    if (id == null) return null
    return list.value.find((p) => p.id === id) ?? null
  }

  /** 按现编号或历史别名（旧编号）查找保留档案。 */
  function byPmNo(pmNo: string): Postmark | null {
    const keyword = pmNo.trim()
    if (!keyword) return null
    return (
      list.value.find(
        (p) => p.pmNo === keyword || (p.aliases ?? []).includes(keyword)
      ) ?? null
    )
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
    mergeInto,
    loadSampleAsset,
    byId,
    byPmNo,
    labelOf
  }
})
