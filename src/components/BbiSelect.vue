<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import { modalHost } from '@/state/ui';
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';

/**
 * 自绘下拉选择(替代原生 <select>):触发器与弹出菜单都跟随 --bbi-* 主题,
 * 选项可带图标;与设置页的 bbi-select-row 行布局配套。
 *
 * 菜单为什么 Teleport 到 modalHost 而不是就地绝对定位:
 * 设置项都在 Collapsible(overflow:hidden)与 .bbi-body 滚动容器里,就地定位会被裁剪
 * (柏宝书踩过同款坑)。modalHost 是 .bbi-root 直接子级,菜单用视口级 fixed 定位,
 * 由触发器的 getBoundingClientRect 推算,下方空间不足时向上翻。
 * 窗口元素平时无 transform(仅移动端拖动抽屉时临时有),fixed 相对视口成立。
 *
 * 交互:点外部 / Esc / 选中关闭;滚动与视口变化时跟随触发器定位。
 * ↑↓ 移动高亮,Enter/Space 选中,Home/End 跳首尾。
 */
const props = defineProps<{
  modelValue: string;
  options: { value: string; label: string; icon?: string }[];
  /** 无障碍名称(行标题是纯文本 span,与控件无 label 关联,靠它补上) */
  ariaLabel?: string;
}>();
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>();

const open = ref(false);
const trigger = ref<HTMLElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const menuStyle = ref<Record<string, string>>({});
/** 键盘/悬停高亮项索引 */
const activeIndex = ref(0);

const current = computed(() => props.options.find(o => o.value === props.modelValue) ?? null);

const MENU_GAP = 4;
const MENU_MAX_HEIGHT = 240;
const VIEWPORT_MARGIN = 8;
let scrollRoot: Node | null = null;

function updateMenuPosition() {
  const el = trigger.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  // 估算菜单高度决定朝向:下方不够且上方更宽裕就向上翻
  const estimated = Math.min(MENU_MAX_HEIGHT, props.options.length * 34 + 10);
  const below = window.innerHeight - rect.bottom - MENU_GAP - VIEWPORT_MARGIN;
  const upward = below < estimated && rect.top - VIEWPORT_MARGIN > below;
  const space = upward ? rect.top - MENU_GAP - VIEWPORT_MARGIN : below;
  menuStyle.value = {
    left: `${rect.left}px`,
    width: `${rect.width}px`,
    maxHeight: `${Math.max(96, Math.min(MENU_MAX_HEIGHT, space))}px`,
    ...(upward
      ? { top: 'auto', bottom: `${window.innerHeight - rect.top + MENU_GAP}px` }
      : { top: `${rect.bottom + MENU_GAP}px`, bottom: 'auto' }),
  };
}

function openMenu() {
  const el = trigger.value;
  if (!el || open.value) return;
  updateMenuPosition();
  activeIndex.value = Math.max(
    0,
    props.options.findIndex(o => o.value === props.modelValue),
  );
  open.value = true;
  // 等 Teleport 菜单挂载后,让长列表中的当前选项进入可见区域。
  void nextTick(() => {
    if (open.value) scrollActiveIntoView();
  });
  document.addEventListener('pointerdown', onDocPointerdown, true);
  document.addEventListener('keydown', onDocKeydown, true);
  // iOS WKWebView 的焦点/键盘切换可能在 click 后继续改变视口，不能据此关闭菜单。
  // 后台聊天滚动也不代表用户要取消选择。只重新计算 fixed 菜单的位置。
  document.addEventListener('scroll', onViewportChange, true);
  const root = el.getRootNode();
  // scroll 不穿过 Shadow DOM；面板内部滚动需要在所在根上监听。
  if (root !== document) {
    scrollRoot = root;
    scrollRoot.addEventListener('scroll', onViewportChange, true);
  }
  window.addEventListener('resize', onViewportChange);
  window.visualViewport?.addEventListener('resize', onViewportChange);
  window.visualViewport?.addEventListener('scroll', onViewportChange);
}

function closeMenu(restoreFocus = false) {
  if (!open.value) return;
  open.value = false;
  document.removeEventListener('pointerdown', onDocPointerdown, true);
  document.removeEventListener('keydown', onDocKeydown, true);
  document.removeEventListener('scroll', onViewportChange, true);
  scrollRoot?.removeEventListener('scroll', onViewportChange, true);
  scrollRoot = null;
  window.removeEventListener('resize', onViewportChange);
  window.visualViewport?.removeEventListener('resize', onViewportChange);
  window.visualViewport?.removeEventListener('scroll', onViewportChange);
  if (restoreFocus) trigger.value?.focus({ preventScroll: true });
}

function onViewportChange(event: Event) {
  if (menu.value && event.composedPath().includes(menu.value)) return;
  updateMenuPosition();
}

function toggle() {
  if (open.value) closeMenu(true);
  else openMenu();
}

function pick(option: { value: string }) {
  emit('update:modelValue', option.value);
  closeMenu(true);
}

function onDocPointerdown(event: PointerEvent) {
  // composedPath 穿透 shadow root;点到触发器或菜单内部都不算外部
  const path = event.composedPath();
  if (trigger.value && path.includes(trigger.value)) return;
  if (menu.value && path.includes(menu.value)) return;
  closeMenu();
}

function scrollActiveIntoView() {
  const list = menu.value;
  const option = list?.querySelectorAll<HTMLElement>('.bbi-select-option')[activeIndex.value];
  if (!list || !option) return;
  // scrollIntoView 会尝试滚动所有祖先（包括宿主聊天页），触发上面的滚动关闭逻辑。
  // 只调整菜单自身，打开时定位当前项和键盘导航都不能移动外层页面。
  const top = list.getBoundingClientRect().top + list.clientTop;
  const bottom = top + list.clientHeight;
  const rect = option.getBoundingClientRect();
  if (rect.top < top) list.scrollTop += rect.top - top;
  else if (rect.bottom > bottom) list.scrollTop += rect.bottom - bottom;
}

function onDocKeydown(event: KeyboardEvent) {
  if (!open.value) return;
  const count = props.options.length;
  if (event.key === 'Escape') {
    // 捕获阶段拦截,只关菜单,别触发窗口级 Esc(关整个面板)
    event.preventDefault();
    event.stopPropagation();
    closeMenu(true);
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    activeIndex.value = (activeIndex.value + delta + count) % count;
    scrollActiveIntoView();
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    activeIndex.value = event.key === 'Home' ? 0 : count - 1;
    scrollActiveIntoView();
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    const option = props.options[activeIndex.value];
    if (option) pick(option);
  }
}

/** 原生 select 习惯:收起态按 ↑/↓ 直接展开 */
function onTriggerKeydown(event: KeyboardEvent) {
  if (open.value) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    openMenu();
  }
}

onBeforeUnmount(() => closeMenu());
</script>

<template>
  <!-- 根类名不能叫 bbi-select:base.css 里那个类是给美化原生 <select> 用的,
       带背景图三角 + padding-right,撞上会在触发器右边多画一个三角 -->
  <div class="bbi-select-box">
    <button
      ref="trigger"
      class="bbi-select-trigger"
      type="button"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-label="ariaLabel"
      @click="toggle"
      @keydown="onTriggerKeydown"
    >
      <span class="bbi-select-current">
        <Icon v-if="current?.icon" :name="current.icon" :size="14" />
        <span class="bbi-select-label">{{ current?.label ?? modelValue }}</span>
      </span>
      <Icon name="chevron" class="bbi-select-caret" :class="{ 'is-open': open }" :size="12" />
    </button>

    <Teleport :to="modalHost" :disabled="!modalHost">
      <ul v-if="open" ref="menu" class="bbi-select-menu" role="listbox" :style="menuStyle">
        <li
          v-for="(option, i) in options"
          :key="option.value"
          class="bbi-select-option"
          :class="{ 'is-active': i === activeIndex, 'is-selected': option.value === modelValue }"
          role="option"
          :aria-selected="option.value === modelValue"
          @mouseenter="activeIndex = i"
          @click="pick(option)"
        >
          <Icon v-if="option.icon" :name="option.icon" :size="14" />
          <span class="bbi-select-option-label">{{ option.label }}</span>
          <Icon
            v-if="option.value === modelValue"
            name="check"
            class="bbi-select-check"
            :size="13"
          />
        </li>
      </ul>
    </Teleport>
  </div>
</template>

<style scoped>
.bbi-select-box {
  width: 180px;
  flex: none;
}
.bbi-select-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface);
  color: var(--bbi-ink);
  font-family: var(--bbi-font-sans);
  font-size: 13px;
  line-height: 1.5;
  cursor: pointer;
  transition:
    border-color var(--bbi-dur) var(--bbi-ease),
    background var(--bbi-dur) var(--bbi-ease);
}
.bbi-select-trigger:hover {
  background: var(--bbi-surface-2);
}
.bbi-select-trigger:focus-visible {
  outline: 2px solid var(--bbi-accent);
  outline-offset: 1px;
}
.bbi-select-current {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.bbi-select-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bbi-select-caret {
  flex: none;
  color: var(--bbi-ink-soft);
  transition: transform var(--bbi-dur) var(--bbi-ease);
}
.bbi-select-caret.is-open {
  transform: rotate(180deg);
}

/* 菜单 Teleport 到 modalHost(scoped 样式在同 shadow root 内照常生效) */
.bbi-select-menu {
  position: fixed;
  /* 10003:高于普通弹窗遮罩(10001)与叠加层遮罩(10002)。
     本组件现在也用在弹窗内部(渠道弹窗的「思考强度」),菜单与遮罩会同时存在;
     同级时靠「后插入者胜出」能侥幸盖住,但删除确认那类 -top 遮罩(10002)会反压菜单,
     故显式抬高,不依赖插入顺序。 */
  z-index: 10003;
  margin: 0;
  padding: 4px;
  list-style: none;
  overflow-y: auto;
  background: var(--bbi-surface);
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  box-shadow: var(--bbi-shadow);
}
.bbi-select-option {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border-radius: var(--bbi-radius-sm);
  font-size: 13px;
  color: var(--bbi-ink);
  cursor: pointer;
}
.bbi-select-option.is-active {
  background: var(--bbi-surface-2);
}
.bbi-select-option.is-selected {
  color: var(--bbi-accent);
  font-weight: 600;
}
.bbi-select-option-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bbi-select-check {
  flex: none;
  color: var(--bbi-accent);
}
</style>
