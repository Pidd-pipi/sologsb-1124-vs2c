<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { UploadFile } from 'element-plus'
import StampCard from '@/components/common/StampCard.vue'
import ScarceTag from '@/components/common/ScarceTag.vue'
import { useCatalogFilter } from '@/hooks/useCatalogFilter'
import { useCoverStore } from '@/stores/coverStore'
import { usePostmarkStore, type ImagePayload } from '@/stores/postmarkStore'
import type { Cover } from '@/types/cover'
import type { Postmark } from '@/types/postmark'
import {
  INK_COLORS,
  POSTMARK_TYPES,
  PROVINCES,
  SCARCE_LEVELS,
  createEmptyPostmark
} from '@/types/postmark'
import { clearDraft, draftSavedAt, loadDraft, saveDraft } from '@/utils/draft'
import { nowIso, toNumber } from '@/utils/id'

const store = usePostmarkStore()
const coverStore = useCoverStore()
const source = computed(() => store.list)
const { filters, filtered, activeCount, reset } = useCatalogFilter<Postmark>('postmark', source)

const viewMode = ref<'wall' | 'list'>('wall')
const dialogVisible = ref(false)
const detailVisible = ref(false)
const sampleVisible = ref(false)
const current = ref<Postmark | null>(null)
const sampleText = ref('')
const imagePayload = ref<ImagePayload | null>(null)
const draftHint = ref('')
const form = reactive<Postmark>(createEmptyPostmark())

onMounted(async () => {
  if (!store.loaded) await store.load()
  if (!coverStore.loaded) await coverStore.load()
  draftHint.value = draftSavedAt('postmark')
})

watch(
  form,
  () => {
    if (!dialogVisible.value) return
    saveDraft('postmark', { ...form, lettering: { ...form.lettering } })
    draftHint.value = nowIso()
  },
  { deep: true }
)

function openCreate(): void {
  Object.assign(form, createEmptyPostmark())
  form.pmNo = store.nextPmNo()
  form.lettering = { top: '', middle: '', bottom: '' }
  imagePayload.value = null
  const draft = loadDraft<Postmark>('postmark')
  if (draft) {
    Object.assign(form, draft)
    form.lettering = draft.lettering ?? { top: '', middle: '', bottom: '' }
    if (form.imageDataUrl) imagePayload.value = { dataUrl: form.imageDataUrl, fileName: '草稿戳样' }
  }
  dialogVisible.value = true
}

function discardDraft(): void {
  clearDraft('postmark')
  draftHint.value = ''
  Object.assign(form, createEmptyPostmark())
  form.pmNo = store.nextPmNo()
  form.lettering = { top: '', middle: '', bottom: '' }
  imagePayload.value = null
  ElMessage.info('已清除本地草稿')
}

function onFileChange(file: UploadFile): void {
  const raw = file.raw
  if (!raw) return
  if (raw.size > 2 * 1024 * 1024) {
    ElMessage.warning('戳样图请控制在 2MB 以内')
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    const dataUrl = String(reader.result ?? '')
    form.imageDataUrl = dataUrl
    imagePayload.value = { dataUrl, fileName: raw.name }
  }
  reader.readAsDataURL(raw)
}

async function submit(): Promise<void> {
  if (!form.office.trim()) {
    ElMessage.warning('请填写使用局所')
    return
  }
  if (toNumber(form.yearFrom) > toNumber(form.yearTo)) {
    ElMessage.warning('使用年代的起始年不能晚于结束年')
    return
  }
  const pmNo = form.pmNo || store.nextPmNo()
  await store.create({ ...form, pmNo, lettering: { ...form.lettering } }, imagePayload.value)
  clearDraft('postmark')
  draftHint.value = ''
  dialogVisible.value = false
  ElMessage.success(`已编目邮戳 ${pmNo}`)
}

function showDetail(pm: Postmark): void {
  current.value = pm
  detailVisible.value = true
}

function buildSampleText(pm: Postmark): string {
  return [
    `戳样条目 ${pm.pmNo}`,
    `戳型：${pm.type}`,
    `局所：${pm.office}（${pm.province || '省份待考'}）`,
    `使用年代：${pm.yearFrom}-${pm.yearTo}`,
    `戳面日期：${pm.dateOnStamp || '未注'}`,
    `戳径/墨色：${pm.diameter}mm / ${pm.inkColor}`,
    `戳面文字：上格「${pm.lettering.top}」 中格「${pm.lettering.middle}」 下格「${pm.lettering.bottom}」`,
    `文字：${pm.bilingual ? '中英双文字' : '单文字'}`,
    `稀见度：${pm.scarceLevel}`,
    `备注：${pm.note || '无'}`
  ].join('\n')
}

function generateSample(pm: Postmark): void {
  sampleText.value = buildSampleText(pm)
  sampleVisible.value = true
}

async function copySample(): Promise<void> {
  try {
    await navigator.clipboard.writeText(sampleText.value)
    ElMessage.success('戳样条目已复制')
  } catch {
    ElMessage.info('浏览器未授权剪贴板，请手动选择文本')
  }
}

/* ------------------------------ 合并到另一枚 ------------------------------ */

interface MergePreview {
  /** 将随关联转来的实寄封 */
  covers: Cover[]
  /** 其中原本同时关联两枚、合并后仅去重不新增的封 */
  duplicateCoverIds: Set<number>
  sourceHasSample: boolean
  targetHasSample: boolean
  /** 保留枚当前戳样的展示地址（缩略图或原图，任一存在即可） */
  targetSampleUrl: string
  /** 保留枚空缺、将接住的原图缩略 dataURL */
  incomingSampleUrl: string
  incomingSampleName: string
  /** 将新记入保留枚的历史别名（原编号 + 原枚更早的旧编号） */
  aliasesToAdd: string[]
}

const mergeVisible = ref(false)
const merging = ref(false)
const mergeSource = ref<Postmark | null>(null)
const mergeTargetId = ref<number | null>(null)
const mergeAck = ref(false)
const mergePreview = ref<MergePreview | null>(null)

/** 合并对话框中可供选择的保留枚（排除当前查看的这枚） */
const mergeCandidates = computed<Postmark[]>(() =>
  store.list.filter((pm) => pm.id !== mergeSource.value?.id)
)

const mergeTarget = computed<Postmark | null>(() =>
  mergeTargetId.value == null ? null : store.byId(mergeTargetId.value)
)

async function openMerge(pm: Postmark): Promise<void> {
  mergeSource.value = pm
  mergeTargetId.value = null
  mergeAck.value = false
  mergePreview.value = null
  mergeVisible.value = true
}

watch(mergeTargetId, async () => {
  mergeAck.value = false
  await refreshMergePreview()
})

async function refreshMergePreview(): Promise<void> {
  const source = mergeSource.value
  const target = mergeTarget.value
  if (!source || !target || source.id == null || target.id == null) {
    mergePreview.value = null
    return
  }

  const related = coverStore.list.filter((c) => c.cancelPmIds.includes(source.id!))
  const duplicateCoverIds = new Set(
    related
      .filter((c) => typeof c.id === 'number' && c.cancelPmIds.includes(target.id!))
      .map((c) => c.id as number)
  )

  const sourceAsset = source.id == null ? null : await store.loadSampleAsset(source.id)
  const targetAsset = target.id == null ? null : await store.loadSampleAsset(target.id)
  const sourceHasSample = !!(source.imageDataUrl && source.imageDataUrl.trim()) || !!sourceAsset
  const targetHasSample = !!(target.imageDataUrl && target.imageDataUrl.trim()) || !!targetAsset

  const incoming = new Set<string>([source.pmNo, ...(source.aliases ?? [])].filter(Boolean))
  for (const alias of target.aliases ?? []) incoming.delete(alias)
  incoming.delete(target.pmNo)

  mergePreview.value = {
    covers: related,
    duplicateCoverIds,
    sourceHasSample,
    targetHasSample,
    targetSampleUrl: target.imageDataUrl?.trim() ? target.imageDataUrl : targetAsset?.dataUrl ?? '',
    incomingSampleUrl: targetHasSample ? '' : sourceAsset?.dataUrl ?? source.imageDataUrl ?? '',
    incomingSampleName: targetHasSample ? '' : sourceAsset?.fileName ?? '原戳样',
    aliasesToAdd: [...incoming]
  }
}

const mergeCanSubmit = computed(
  () => mergeTargetId.value != null && mergeAck.value && !merging.value
)

async function submitMerge(): Promise<void> {
  const source = mergeSource.value
  const targetId = mergeTargetId.value
  if (!source || source.id == null || targetId == null || !mergePreview.value) return
  try {
    await ElMessageBox.confirm(
      `确认将 ${source.pmNo} 合并到 ${mergeTarget.value?.pmNo ?? ''}？原编号将成为历史别名，操作不可撤销。`,
      '最终确认合并',
      { type: 'warning', confirmButtonText: '确认合并', cancelButtonText: '再想想' }
    )
  } catch {
    return
  }
  merging.value = true
  try {
    const result = await store.mergeInto(source.id, targetId)
    ElMessage.success(
      `已合并：${result.transferredCoverCount} 封实寄封改挂保留枚，` +
        `历史别名记录 ${result.aliasesAdded.length} 个旧编号` +
        (result.sampleTakenOver ? '，原戳样已接入空缺位置' : '')
    )
    mergeVisible.value = false
    current.value = store.byId(targetId)
    detailVisible.value = true
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '合并失败，请重试')
  } finally {
    merging.value = false
  }
}
</script>

<template>
  <div class="gb-page postmark-page">
    <header class="gb-page__head">
      <div>
        <h1 class="gb-page__title">邮戳目录</h1>
        <p class="gb-page__subtitle">
          共 {{ store.total }} 枚邮戳，其中罕见以上 {{ store.scarceCount }} 枚；按戳型、局所、年代区间检索。
        </p>
      </div>
      <div class="postmark-page__actions">
        <el-radio-group v-model="viewMode" size="small">
          <el-radio-button value="wall">图片墙</el-radio-button>
          <el-radio-button value="list">列表</el-radio-button>
        </el-radio-group>
        <el-button type="primary" @click="openCreate">新增邮戳</el-button>
      </div>
    </header>

    <section class="gb-panel">
      <h2 class="gb-panel__title">筛选（{{ activeCount }} 项生效）</h2>
      <el-form :inline="true" label-width="72px" @submit.prevent>
        <el-form-item label="关键词">
          <el-input v-model="filters.keyword" placeholder="编目号 / 戳面文字 / 备注" clearable />
        </el-form-item>
        <el-form-item label="戳型">
          <el-select v-model="filters.type" placeholder="全部戳型" clearable style="width: 150px">
            <el-option v-for="t in POSTMARK_TYPES" :key="t" :label="t" :value="t" />
          </el-select>
        </el-form-item>
        <el-form-item label="局所">
          <el-input v-model="filters.office" placeholder="如 上海" clearable />
        </el-form-item>
        <el-form-item label="省份">
          <el-select v-model="filters.province" placeholder="全部省份" clearable style="width: 130px">
            <el-option v-for="p in PROVINCES" :key="p" :label="p" :value="p" />
          </el-select>
        </el-form-item>
        <el-form-item label="年代区间">
          <el-input v-model="filters.era" placeholder="如 1900-1949" clearable style="width: 150px" />
        </el-form-item>
        <el-form-item label="稀见度">
          <el-select v-model="filters.scarceLevel" placeholder="全部" clearable style="width: 120px">
            <el-option v-for="s in SCARCE_LEVELS" :key="s" :label="s" :value="s" />
          </el-select>
        </el-form-item>
        <el-form-item label="排序">
          <el-select v-model="filters.sortKey" style="width: 150px">
            <el-option label="最近更新" value="recent" />
            <el-option label="编号升序" value="noAsc" />
            <el-option label="年代升序" value="yearAsc" />
            <el-option label="年代降序" value="yearDesc" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button @click="reset">重置筛选</el-button>
        </el-form-item>
      </el-form>
    </section>

    <p v-if="!filtered.length" class="gb-empty">没有符合当前条件的邮戳，试试放宽年代区间或清空戳型。</p>

    <div v-else-if="viewMode === 'wall'" class="gb-grid">
      <StampCard
        v-for="pm in filtered"
        :key="pm.id"
        :postmark="pm"
        :active="current?.id === pm.id"
        @select="showDetail"
      />
    </div>

    <el-table v-else :data="filtered" border stripe @row-click="showDetail">
      <el-table-column prop="pmNo" label="编目号" width="120" />
      <el-table-column prop="type" label="戳型" width="130" />
      <el-table-column prop="office" label="使用局所" min-width="160" />
      <el-table-column prop="province" label="省份" width="90" />
      <el-table-column label="使用年代" width="120">
        <template #default="{ row }">{{ row.yearFrom }}-{{ row.yearTo }}</template>
      </el-table-column>
      <el-table-column prop="dateOnStamp" label="戳面日期" width="120" />
      <el-table-column label="戳径" width="90">
        <template #default="{ row }">{{ row.diameter }}mm</template>
      </el-table-column>
      <el-table-column prop="inkColor" label="墨色" width="80" />
      <el-table-column label="稀见度" width="100">
        <template #default="{ row }">
          <ScarceTag :level="row.scarceLevel" />
        </template>
      </el-table-column>
      <el-table-column label="操作" width="250">
        <template #default="{ row }">
          <el-button size="small" link type="primary" @click.stop="showDetail(row)">查看</el-button>
          <el-button size="small" link type="primary" @click.stop="generateSample(row)">
            生成戳样条目
          </el-button>
          <el-button size="small" link type="danger" @click.stop="openMerge(row)">
            合并到另一枚
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialogVisible" title="新增邮戳" width="720px">
      <el-form label-width="104px" label-position="right">
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="编目号">
              <el-input v-model="form.pmNo" placeholder="留空自动生成" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="戳型">
              <el-select v-model="form.type" style="width: 100%">
                <el-option v-for="t in POSTMARK_TYPES" :key="t" :label="t" :value="t" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="使用局所">
              <el-input v-model="form.office" placeholder="如 上海邮政总局" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="省份">
              <el-select v-model="form.province" placeholder="选择省份" clearable style="width: 100%">
                <el-option v-for="p in PROVINCES" :key="p" :label="p" :value="p" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="年代起">
              <el-input-number v-model="form.yearFrom" :min="1800" :max="2100" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="年代止">
              <el-input-number v-model="form.yearTo" :min="1800" :max="2100" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="戳面日期">
              <el-date-picker
                v-model="form.dateOnStamp"
                type="date"
                value-format="YYYY-MM-DD"
                placeholder="戳面所注日期"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="墨色">
              <el-select v-model="form.inkColor" style="width: 100%">
                <el-option v-for="c in INK_COLORS" :key="c" :label="c" :value="c" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="戳径(mm)">
              <el-input-number v-model="form.diameter" :min="10" :max="90" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="稀见度">
              <el-select v-model="form.scarceLevel" style="width: 100%">
                <el-option v-for="s in SCARCE_LEVELS" :key="s" :label="s" :value="s" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="上格">
              <el-input v-model="form.lettering.top" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="中格">
              <el-input v-model="form.lettering.middle" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="下格">
              <el-input v-model="form.lettering.bottom" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="中英双文字">
              <el-switch v-model="form.bilingual" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="戳样图">
              <el-upload
                :auto-upload="false"
                :show-file-list="false"
                accept="image/*"
                :on-change="onFileChange"
              >
                <el-button>选择戳样图</el-button>
              </el-upload>
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="备注">
              <el-input v-model="form.note" type="textarea" :rows="2" />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <div class="postmark-page__footer">
          <span class="postmark-page__draft">
            {{ draftHint ? '表单草稿已存入浏览器 localStorage' : '未保存草稿' }}
          </span>
          <span>
            <el-button link type="info" @click="discardDraft">清除草稿</el-button>
            <el-button @click="dialogVisible = false">取消</el-button>
            <el-button type="primary" @click="submit">保存邮戳</el-button>
          </span>
        </div>
      </template>
    </el-dialog>

    <el-drawer v-model="detailVisible" title="邮戳档案" size="460px">
      <div v-if="current" class="postmark-page__detail">
        <div class="gb-figure">
          <img v-if="current.imageDataUrl" :src="current.imageDataUrl" :alt="`${current.pmNo} 戳样`" />
          <span v-else class="postmark-page__no-image">暂无戳样图</span>
        </div>
        <h3 class="gb-panel__title">{{ current.pmNo }} · {{ current.type }}</h3>
        <ScarceTag :level="current.scarceLevel" />
        <div v-if="current.aliases && current.aliases.length" class="postmark-page__aliases">
          <span class="postmark-page__aliases-label">历史编号：</span>
          <el-tag
            v-for="alias in current.aliases"
            :key="alias"
            size="small"
            type="info"
            effect="plain"
          >
            {{ alias }}
          </el-tag>
        </div>
        <dl class="gb-facts">
          <div><dt>使用局所</dt><dd>{{ current.office }}</dd></div>
          <div><dt>省份</dt><dd>{{ current.province || '待考' }}</dd></div>
          <div><dt>使用年代</dt><dd>{{ current.yearFrom }}-{{ current.yearTo }}</dd></div>
          <div><dt>戳面日期</dt><dd>{{ current.dateOnStamp || '未注' }}</dd></div>
          <div><dt>戳径</dt><dd>{{ current.diameter }} mm</dd></div>
          <div><dt>墨色</dt><dd>{{ current.inkColor }}</dd></div>
          <div><dt>戳面文字</dt><dd>{{ current.lettering.top }} / {{ current.lettering.middle }} / {{ current.lettering.bottom }}</dd></div>
          <div><dt>文字</dt><dd>{{ current.bilingual ? '中英双文字' : '单文字' }}</dd></div>
        </dl>
        <p class="postmark-page__note">{{ current.note || '暂无备注' }}</p>
        <div class="postmark-page__detail-actions">
          <el-button type="primary" plain @click="generateSample(current)">生成戳样条目</el-button>
          <el-button type="danger" plain @click="openMerge(current)">合并到另一枚</el-button>
        </div>
      </div>
    </el-drawer>

    <el-dialog v-model="sampleVisible" title="戳样条目" width="560px">
      <el-input v-model="sampleText" type="textarea" :rows="10" readonly />
      <template #footer>
        <el-button @click="sampleVisible = false">关闭</el-button>
        <el-button type="primary" @click="copySample">复制条目</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="mergeVisible" title="合并到另一枚" width="640px">
      <div v-if="mergeSource" class="postmark-merge">
        <p class="postmark-merge__lead">
          将 <strong>{{ mergeSource.pmNo }}</strong>
          <span class="postmark-merge__office">{{ mergeSource.office }}</span>
          并入另一枚保留邮戳。请先核对以下将要转来的实寄封与图片，确认无误后再执行。
        </p>

        <el-form label-width="96px">
          <el-form-item label="保留邮戳">
            <el-select
              v-model="mergeTargetId"
              filterable
              placeholder="选择合并后保留的邮戳"
              style="width: 100%"
            >
              <el-option
                v-for="pm in mergeCandidates"
                :key="pm.id"
                :label="`${pm.pmNo} ${pm.office}（${pm.type}）`"
                :value="Number(pm.id)"
              />
            </el-select>
          </el-form-item>
        </el-form>

        <template v-if="mergePreview && mergeTarget">
          <el-alert
            :closable="false"
            type="info"
            show-icon
            class="postmark-merge__alert"
            :title="`合并后实寄封上的销票关联统一指向 ${mergeTarget.pmNo}；票戳组合与寄递记录不动，用旧编号检索仍可找到本档案。`"
          />

          <section class="postmark-merge__block">
            <h4 class="postmark-merge__block-title">
              将转来的实寄封（{{ mergePreview.covers.length }} 封）
            </h4>
            <p v-if="!mergePreview.covers.length" class="postmark-merge__empty">
              该枚邮戳当前没有实寄封关联，仅合并档案本身。
            </p>
            <el-table v-else :data="mergePreview.covers" size="small" border max-height="220">
              <el-table-column prop="coverNo" label="封号" width="110" />
              <el-table-column label="收寄地" min-width="170">
                <template #default="{ row }">{{ row.sentFrom }} → {{ row.sentTo }}</template>
              </el-table-column>
              <el-table-column prop="postDate" label="寄出日期" width="110" />
              <el-table-column label="关联处理" width="120">
                <template #default="{ row }">
                  <el-tag
                    v-if="mergePreview.duplicateCoverIds.has(Number(row.id))"
                    size="small"
                    type="info"
                    effect="plain"
                  >
                    去重保留一项
                  </el-tag>
                  <el-tag v-else size="small" type="warning" effect="plain">改挂保留枚</el-tag>
                </template>
              </el-table-column>
            </el-table>
          </section>

          <section class="postmark-merge__block">
            <h4 class="postmark-merge__block-title">戳样图片</h4>
            <div class="postmark-merge__sample">
              <div v-if="mergePreview.targetHasSample" class="postmark-merge__sample-cell">
                <img :src="mergePreview.targetSampleUrl" :alt="`${mergeTarget.pmNo} 保留戳样`" />
                <span>保留枚已有戳样，原戳样不覆盖、不并入。</span>
              </div>
              <template v-else>
                <div class="postmark-merge__sample-cell">
                  <img :src="mergePreview.targetSampleUrl" :alt="`${mergeTarget.pmNo} 暂无戳样`" />
                  <span>保留枚当前空缺。</span>
                </div>
                <span class="postmark-merge__arrow">→</span>
                <div class="postmark-merge__sample-cell">
                  <img
                    v-if="mergePreview.incomingSampleUrl"
                    :src="mergePreview.incomingSampleUrl"
                    alt="将接住的原戳样"
                  />
                  <span v-else class="postmark-merge__no-sample">原枚也无戳样</span>
                  <span v-if="mergePreview.sourceHasSample">空缺位置接住原图（{{ mergePreview.incomingSampleName }}）。</span>
                  <span v-else>双方均无戳样，无图片可接。</span>
                </div>
              </template>
            </div>
          </section>

          <section class="postmark-merge__block">
            <h4 class="postmark-merge__block-title">历史别名（旧编号）</h4>
            <p v-if="!mergePreview.aliasesToAdd.length" class="postmark-merge__empty">
              没有新的旧编号需要记录（可能此前已合并过，仍回到同一枚）。
            </p>
            <div v-else class="postmark-merge__alias-tags">
              <el-tag
                v-for="alias in mergePreview.aliasesToAdd"
                :key="alias"
                size="small"
                type="info"
                effect="plain"
              >
                {{ alias }}
              </el-tag>
              <span class="postmark-merge__alias-hint">
                将记入 {{ mergeTarget.pmNo}} 的历史编号，目录按这些编号也能检索到本档案。
              </span>
            </div>
            <p
              v-if="mergeTarget.aliases && mergeTarget.aliases.length"
              class="postmark-merge__existing"
            >
              保留枚已有历史编号：{{ mergeTarget.aliases.join('、') }}
            </p>
          </section>

          <el-checkbox v-model="mergeAck" class="postmark-merge__ack">
            我已核对以上实寄封与图片，确认合并不可撤销
          </el-checkbox>
        </template>
      </div>
      <template #footer>
        <el-button @click="mergeVisible = false">取消</el-button>
        <el-button
          type="danger"
          :disabled="!mergeCanSubmit"
          :loading="merging"
          @click="submitMerge"
        >
          确认合并
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.postmark-page__actions {
  display: flex;
  gap: 10px;
  align-items: center;
}
.postmark-page__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.postmark-page__draft {
  font-size: 12px;
  color: var(--gb-muted);
}
.postmark-page__detail {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: flex-start;
}
.postmark-page__no-image {
  font-size: 12px;
  color: var(--gb-muted);
}
.postmark-page__note {
  font-size: 13px;
  color: var(--gb-muted);
  line-height: 1.6;
}
.postmark-page__aliases {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.postmark-page__aliases-label {
  font-size: 13px;
  color: var(--gb-muted);
}
.postmark-page__detail-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.postmark-merge__lead {
  margin: 0 0 14px;
  font-size: 14px;
  line-height: 1.7;
}
.postmark-merge__lead strong {
  color: #5d3325;
  font-size: 15px;
}
.postmark-merge__office {
  color: var(--gb-muted);
  margin-left: 4px;
}
.postmark-merge__alert {
  margin-bottom: 14px;
}
.postmark-merge__block {
  margin-bottom: 14px;
}
.postmark-merge__block-title {
  margin: 0 0 8px;
  font-size: 14px;
  color: #3f3226;
}
.postmark-merge__empty {
  margin: 0;
  font-size: 13px;
  color: var(--gb-muted);
}
.postmark-merge__sample {
  display: flex;
  align-items: stretch;
  gap: 12px;
}
.postmark-merge__sample-cell {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
  background: #f8f2e8;
  border: 1px solid var(--gb-line, #e4d9c8);
  border-radius: 8px;
  padding: 10px;
  font-size: 12px;
  color: var(--gb-muted);
  text-align: center;
}
.postmark-merge__sample-cell img {
  width: 96px;
  height: 96px;
  object-fit: cover;
  border-radius: 6px;
  background: #fff;
}
.postmark-merge__arrow {
  align-self: center;
  font-size: 18px;
  color: #8c3b2e;
}
.postmark-merge__no-sample {
  width: 96px;
  height: 96px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: #a89578;
}
.postmark-merge__alias-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.postmark-merge__alias-hint {
  font-size: 12px;
  color: var(--gb-muted);
}
.postmark-merge__existing {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--gb-muted);
}
.postmark-merge__ack {
  margin-top: 4px;
}
</style>
