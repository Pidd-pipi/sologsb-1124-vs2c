/**
 * 临时集成验证：邮戳「合并到另一枚」的核心语义。
 * 用 fake-indexeddb 在内存中跑 Dexie + 真实 store 代码。
 */
import 'fake-indexeddb/auto'
import { createPinia, setActivePinia } from 'pinia'
import { db } from '../src/utils/db'
import { usePostmarkStore } from '../src/stores/postmarkStore'
import { useCoverStore } from '../src/stores/coverStore'
import type { Postmark } from '../src/types/postmark'
import type { Cover } from '../src/types/cover'
import type { StamplessEntry } from '../src/types/stampentry'

let failures = 0
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ✓ ${msg}`)
  } else {
    failures += 1
    console.error(`  ✗ ${msg}`)
  }
}

function pm(id: number, pmNo: string, image = '', aliases: string[] = []): Postmark {
  return {
    id,
    pmNo,
    type: '圆形日戳',
    office: `局${id}`,
    province: '上海',
    yearFrom: 1910,
    yearTo: 1920,
    dateOnStamp: '',
    inkColor: '黑',
    diameter: 26,
    lettering: { top: '', middle: '', bottom: '' },
    bilingual: false,
    scarceLevel: '常见',
    imageDataUrl: image,
    aliases,
    note: '',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z'
  }
}

function cover(id: number, coverNo: string, cancelPmIds: number[]): Cover {
  return {
    id,
    coverNo,
    sentFrom: '上海',
    sentTo: '南京',
    postDate: '1910-06-18',
    arriveDate: '',
    franking: [],
    cancelPmIds,
    routeId: null,
    viaPoints: [],
    registered: false,
    conditionGrade: '中品',
    acquireFrom: '',
    price: 0,
    storageAlbum: '',
    frontImage: '',
    backImage: '',
    note: '',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z'
  }
}

async function main(): Promise<void> {
  await db.open()

  // 1..6 邮戳；封：C1→[2]，C2→[2,1]（重复），C3→[3]，C4→[6]
  await db.postmarks.bulkPut([
    pm(1, 'PM-0001', 'data:image/png;TARGET'),
    pm(2, 'PM-0002', '', ['PM-0020']), // 原枚无缩略图但有 assets 原图、带旧别名
    pm(3, 'PM-0003', 'data:image/png;SRC3'),
    pm(4, 'PM-0004'), // 无戳样
    pm(5, 'PM-0005', '', ['PM-0099']),
    pm(6, 'PM-0006')
  ])
  await db.covers.bulkPut([
    cover(1, 'CV-0001', [2]),
    cover(2, 'CV-0002', [2, 1]),
    cover(3, 'CV-0003', [3]),
    cover(4, 'CV-0004', [6])
  ])
  await db.stampEntries.bulkPut([
    {
      id: 1,
      coverId: 1,
      stampName: '蟠龙邮票',
      denomination: 3,
      issueYear: 1908,
      perforation: 'P14',
      variety: '正品',
      positionOnCover: '右上',
      createdAt: '2024-01-01T00:00:00.000Z'
    }
  ])
  await db.assets.bulkAdd([
    { ownerType: 'postmark', ownerId: 2, side: 'sample', dataUrl: 'data:image/png;ASSET2', fileName: '2.png', updatedAt: 'x' },
    { ownerType: 'postmark', ownerId: 3, side: 'sample', dataUrl: 'data:image/png;ASSET3', fileName: '3.png', updatedAt: 'x' }
  ])

  setActivePinia(createPinia())
  const postmarks = usePostmarkStore()
  const covers = useCoverStore()
  await postmarks.load()
  await covers.load()

  console.log('场景一：2 → 1（保留枚已有戳样，不覆盖；原别名并入）')
  let r = await postmarks.mergeInto(2, 1)
  const t1 = await db.postmarks.get(1)
  const c1 = await db.covers.get(1)
  const c2 = await db.covers.get(2)
  assert(t1!.imageDataUrl === 'data:image/png;TARGET', '保留枚戳样未被覆盖')
  assert(t1!.aliases.includes('PM-0002') && t1!.aliases.includes('PM-0020'), '原编号与旧别名 PM-0020 都记入保留枚')
  assert(JSON.stringify(c1!.cancelPmIds) === '[1]', 'C1 销票关联改挂保留枚 [1]')
  assert(JSON.stringify(c2!.cancelPmIds) === '[1]', 'C2 原本两枚都关联，合并后去重为 [1]')
  assert(r.transferredCoverCount === 2, '统计改挂实寄封 2 封')
  const asset2 = (await db.assets.where('ownerId').equals(2).toArray()).length
  assert(asset2 === 0, '原枚未被接住的戳样原图已清理')
  assert((await db.postmarks.get(2)) == null, '原邮戳 PM-0002 记录已删除')
  assert(postmarks.byPmNo('PM-0002')?.id === 1, 'byPmNo 用旧编号 PM-0002 能找到保留档案')
  assert(postmarks.byPmNo('PM-0020')?.id === 1, 'byPmNo 用更早旧编号 PM-0020 也能找到')
  assert(postmarks.nextPmNo() === 'PM-0100', 'nextPmNo 连旧别名占用的编号（PM-0020、PM-0099）一起跳过 → PM-0100')

  console.log('场景二：3 → 4（保留枚空缺，接住缩略图与原图）')
  r = await postmarks.mergeInto(3, 4)
  const t4 = await db.postmarks.get(4)
  assert(t4!.imageDataUrl === 'data:image/png;SRC3', '保留枚缩略图接住原图来源（缩略字段）')
  const a3 = await db.assets.where('ownerId').equals(4).toArray()
  assert(a3.some((a) => a.dataUrl === 'data:image/png;ASSET3'), 'assets 原图行改挂到保留枚 ownerId=4')
  assert((await db.assets.where('ownerId').equals(3).toArray()).length === 0, '原枚 assets 已清空')
  assert(r.sampleTakenOver === true, '统计标记戳样已接住')
  const c3 = await db.covers.get(3)
  assert(JSON.stringify(c3!.cancelPmIds) === '[4]', 'C3 销票关联改挂保留枚 [4]')

  console.log('场景三：链式合并 6 → 5 → 1（同组反复合并回到同一枚）')
  await postmarks.mergeInto(6, 5)
  let t5 = await db.postmarks.get(5)
  assert(t5!.aliases.includes('PM-0006'), '6→5：PM-0006 记为 5 的历史别名')
  const c4a = await db.covers.get(4)
  assert(JSON.stringify(c4a!.cancelPmIds) === '[5]', 'C4 先改挂 [5]')
  await postmarks.mergeInto(5, 1)
  const t1b = await db.postmarks.get(1)
  assert(t1b!.aliases.includes('PM-0005'), '5→1：PM-0005 并入 1')
  assert(t1b!.aliases.includes('PM-0006'), '5→1：早先并入的 PM-0006 跟随并入 1')
  assert(!t1b!.aliases.includes('PM-0099') || true, '（PM-0099 作为别名一并传递）')
  assert(t1b!.aliases.includes('PM-0099'), 'PM-0099 旧别名跟随链路保留在最终档案')
  const noDup = new Set(t1b!.aliases)
  assert(noDup.size === t1b!.aliases.length, '历史别名无重复')
  const c4b = await db.covers.get(4)
  assert(JSON.stringify(c4b!.cancelPmIds) === '[1]', 'C4 最终统一指向 [1]（反复合并回到同一枚）')
  assert(postmarks.byPmNo('PM-0006')?.id === 1, '链式合并后用 PM-0006 仍找到最终保留枚')
  assert((await db.postmarks.get(5)) == null && (await db.postmarks.get(6)) == null, 'PM-0005/0006 记录均删除')

  console.log('场景四：票戳组合与寄递记录不受影响')
  const e1 = await db.stampEntries.get(1)
  assert(e1?.coverId === 1 && e1.stampName === '蟠龙邮票', '封 1 的票戳组合明细原样可查')
  const storedC1 = await db.covers.get(1)
  assert(storedC1!.coverNo === 'CV-0001' && storedC1!.sentFrom === '上海', '寄递事实（封号/收寄地）未改动')

  console.log('场景五：不能合并到自身')
  let threw = false
  try {
    await postmarks.mergeInto(1, 1)
  } catch {
    threw = true
  }
  assert(threw, 'source === target 时抛错')

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`)
  await db.delete()
  if (failures > 0) process.exit(1)
}

void main()
