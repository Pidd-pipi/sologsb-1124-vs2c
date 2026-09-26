<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { usePostmarkStore, type MergePreview, type MergeResult } from '@/stores/postmarkStore'
import type { Postmark } from '@/types/postmark'
import type { CatalogAsset } from '@/types/asset'

const props = defineProps<{
  modelValue: boolean
  source: Postmark | null
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  merged: [result: MergeResult]
}>()

const store = usePostmarkStore()

const visible = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v)
})

/** 候选保留枚：排除源枚自身 */
const targetOptions = computed(() =>
  store.list
    .filter((pm) => pm.id !== props.source?.id && typeof pm.id === 'number')
    .map((pm) => ({
      value: pm.id as number,
      label: `${pm.pmNo} ${pm.office}${pm.aliases?.length ? `（含旧号 ${pm.aliases.join('、')}）` : ''}`
    }))
)

const targetId = ref<number | null>(null)
const preview = ref<MergePreview | null>(null)
const previewing = ref(false)
const submitting = ref(false)

watch(
  () => [props.modelValue, props.source?.id] as const,
  ([open]) => {
    if (open) {
      targetId.value = null
      preview.value = null
    }
  }
)

watch(targetId, (id) => void loadPreview(id))

async function loadPreview(id: number | null): Promise<void> {
  const sourceId = props.source?.id
  preview.value = null
  if (id == null || typeof sourceId !== 'number') return
  previewing.value = true
  try {
    preview.value = await store.previewMerge(sourceId, id)
  } catch (err) {
    ElMessage.warning(err instanceof Error ? err.message : '无法生成合并预览')
  } finally {
    previewing.value = false
  }
}

/** 预览图优先展示原图，原图缺失时回落到缩略 dataURL。 */
function imageOf(asset: CatalogAsset | null, thumb: string): string {
  return asset?.dataUrl || thumb || ''
}

const imageHint = computed<string>(() => {
  const p = preview.value
  if (!p) return ''
  if (p.targetAsset) return '保留枚已有戳样原图，源枚原图不覆盖。'
  if (p.sourceAsset) return '保留枚戳样原图空缺，将接住源枚戳样原图。'
  if (p.thumbnailMoves) return '两枚均无原图；保留枚缩略图空缺，将接住源枚缩略图。'
  if (p.source.imageDataUrl) return '保留枚已有缩略图，源枚缩略图不覆盖。'
  return '两枚均未留存戳样图。'
})

async function confirmMerge(): Promise<void> {
  const sourceId = props.source?.id
  const keepId = targetId.value
  const p = preview.value
  if (typeof sourceId !== 'number' || keepId == null || !p) return
  try {
    await ElMessageBox.confirm(
      `确认把 ${p.source.pmNo} 合并到 ${p.target.pmNo}？该操作会改指 ${p.affectedCovers.length} 枚实寄封的销票关联，且不可撤销。`,
      '合并确认',
      {
        confirmButtonText: '确认合并',
        cancelButtonText: '再看看',
        type: 'warning'
      }
    )
  } catch {
    return
  }
  submitting.value = true
  try {
    const result = await store.mergeTo(sourceId, keepId)
    ElMessage.success(
      `已合并：${p.source.pmNo} 记为历史别名，${result.affectedCoverIds.length} 枚实寄封改指 ${p.target.pmNo}`
    )
    visible.value = false
    emit('merged', result)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '合并失败')
  } finally {
    submitting.value = false
  }
}

function coverLine(no: string, from: string, to: string): string {
  return `${no}　${from || '寄出地待考'} → ${to || '收件地待考'}`
}
</script>

<template>
  <el-dialog v-model="visible" title="合并到另一枚邮戳" width="720px">
    <div v-if="source" class="merge-dialog">
      <el-alert type="info" :closable="false" show-icon class="merge-dialog__tip">
        <template #title>
          合并后 {{ source.pmNo }}
          <template v-if="source.aliases?.length">（及其旧号 {{ source.aliases.join('、') }}）</template>
          将作为历史别名保留，目录用旧编号仍能查到保留档案；源枚档案随即删除。
        </template>
      </el-alert>

      <el-form label-width="96px" class="merge-dialog__form">
        <el-form-item label="待合并邮戳">
          <el-tag type="info" effect="plain">{{ source.pmNo }} {{ source.office }}</el-tag>
        </el-form-item>
        <el-form-item label="保留邮戳">
          <el-select
            v-model="targetId"
            filterable
            placeholder="选择同一枚戳的另一条编目"
            style="width: 100%"
          >
            <el-option
              v-for="opt in targetOptions"
              :key="opt.value"
              :label="opt.label"
              :value="opt.value"
            />
          </el-select>
        </el-form-item>
      </el-form>

      <div v-if="previewing" v-loading="true" class="merge-dialog__loading" element-loading-text="正在整理转来的关联…" />

      <template v-else-if="preview">
        <section class="merge-dialog__block">
          <h4>将转来的实寄封（{{ preview.affectedCovers.length }} 枚）</h4>
          <p v-if="!preview.affectedCovers.length" class="merge-dialog__empty">
            没有实寄封引用该枚邮戳，仅合并档案与戳样。
          </p>
          <ul v-else class="merge-dialog__covers">
            <li v-for="cover in preview.affectedCovers" :key="cover.id">
              <span>{{ coverLine(cover.coverNo, cover.sentFrom, cover.sentTo) }}</span>
              <el-tag size="small" type="warning" effect="plain">销票关联改指保留枚</el-tag>
            </li>
          </ul>
        </section>

        <section class="merge-dialog__block">
          <h4>戳样图去向</h4>
          <div class="merge-dialog__figures">
            <figure>
              <figcaption>源枚 {{ preview.source.pmNo }}</figcaption>
              <div class="merge-dialog__figure">
                <img
                  v-if="imageOf(preview.sourceAsset, preview.source.imageDataUrl)"
                  :src="imageOf(preview.sourceAsset, preview.source.imageDataUrl)"
                  :alt="`${preview.source.pmNo} 戳样`"
                />
                <span v-else class="merge-dialog__no-image">无戳样图</span>
              </div>
              <el-tag size="small" :type="preview.sourceAsset ? 'success' : 'info'" effect="plain">
                {{ preview.sourceAsset ? '有原图' : '仅缩略图' }}
              </el-tag>
            </figure>
            <span class="merge-dialog__arrow">→</span>
            <figure>
              <figcaption>保留枚 {{ preview.target.pmNo }}</figcaption>
              <div class="merge-dialog__figure">
                <img
                  v-if="imageOf(preview.targetAsset, preview.target.imageDataUrl)"
                  :src="imageOf(preview.targetAsset, preview.target.imageDataUrl)"
                  :alt="`${preview.target.pmNo} 戳样`"
                />
                <span v-else class="merge-dialog__no-image">空缺，接住原图</span>
              </div>
              <el-tag size="small" :type="preview.targetAsset ? 'warning' : 'success'" effect="plain">
                {{ preview.targetAsset ? '已有原图不覆盖' : preview.sourceAsset ? '原图空缺待接' : '无原图' }}
              </el-tag>
            </figure>
          </div>
          <p class="merge-dialog__hint">{{ imageHint }}</p>
        </section>

        <section class="merge-dialog__block">
          <h4>合并后保留枚的历史别名</h4>
          <div class="merge-dialog__aliases">
            <el-tag v-for="alias in preview.aliasesAfter" :key="alias" size="small" effect="plain">
              {{ alias }}
            </el-tag>
          </div>
        </section>
      </template>
    </div>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button
        type="danger"
        :disabled="targetId == null || !preview"
        :loading="submitting"
        @click="confirmMerge"
      >
        确认合并
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.merge-dialog__tip {
  margin-bottom: 14px;
}
.merge-dialog__form {
  margin-bottom: 4px;
}
.merge-dialog__loading {
  min-height: 160px;
}
.merge-dialog__block {
  margin-top: 14px;
}
.merge-dialog__block h4 {
  margin: 0 0 8px;
  font-size: 14px;
  color: #5d3325;
}
.merge-dialog__empty {
  margin: 0;
  font-size: 13px;
  color: var(--gb-muted);
}
.merge-dialog__covers {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
  max-height: 180px;
  overflow: auto;
}
.merge-dialog__covers li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 13px;
  color: #3f3226;
  border-bottom: 1px dashed var(--gb-line, #e4d9c8);
  padding-bottom: 5px;
}
.merge-dialog__figures {
  display: flex;
  align-items: center;
  gap: 18px;
}
.merge-dialog__figures figure {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
}
.merge-dialog__figures figcaption {
  font-size: 12px;
  color: var(--gb-muted);
}
.merge-dialog__figure {
  width: 132px;
  height: 132px;
  border-radius: 8px;
  overflow: hidden;
  background: #f6efe3;
  border: 1px solid var(--gb-line, #e4d9c8);
  display: flex;
  align-items: center;
  justify-content: center;
}
.merge-dialog__figure img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.merge-dialog__no-image {
  font-size: 12px;
  color: #a89578;
  padding: 0 8px;
  text-align: center;
}
.merge-dialog__arrow {
  font-size: 20px;
  color: #8c3b2e;
}
.merge-dialog__hint {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--gb-muted);
}
.merge-dialog__aliases {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
</style>
