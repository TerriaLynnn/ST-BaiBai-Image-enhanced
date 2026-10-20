import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import { createRenderer, h, markRaw, nextTick, reactive, ssrContextKey } from 'vue';
import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc';
import BbiSelect from './BbiSelect.vue';
import NaiArtistManager from '@/pages/backend/panels/NaiArtistManager.vue';
import { settings } from '@/state/settings';

vi.mock('@/components/Icon.vue', () => ({ default: () => null }));
vi.mock('@/components/BbiTextarea.vue', () => ({ default: () => null }));
vi.mock('@/components/ConfirmDialog.vue', () => ({ default: () => null }));
vi.mock('@/components/ModalMask.vue', async () => {
  const { h } = await import('vue');
  return { default: {
    props: ['open'],
    setup: (props: { open: boolean }, { slots }: { slots: { default?: () => any } }) =>
      () => props.open ? h('modal', slots.default?.()) : null,
  } };
});
vi.mock('@/state/ui', () => ({ modalHost: null }));
vi.mock('@/state/settings', async () => {
  const { reactive } = await import('vue');
  return { settings: reactive({ nai: { artistPresets: [], activeArtistId: '' } }), newNaiArtist: vi.fn() };
});
vi.mock('vue', async importOriginal => ({
  ...await importOriginal<typeof import('vue')>(), vModelText: {}, vModelCheckbox: {},
}));

function clientComponent(component: any, file: string) {
  const { descriptor } = parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
  const template = compileTemplate({
    source: descriptor.template!.content, filename: file, id: 'navigation-test',
    compilerOptions: { mode: 'function', bindingMetadata: compileScript(descriptor, { id: 'navigation-test' }).bindings },
  });
  if (template.errors.length) throw new Error(template.errors.join('\n'));
  return { ...component, render: new Function('Vue', template.code)(Vue) };
}
const Select = clientComponent(BbiSelect, './BbiSelect.vue');
const Manager = clientComponent(NaiArtistManager, '../pages/backend/panels/NaiArtistManager.vue');

interface TestNode {
  type: string;
  props: Record<string, any>;
  children: TestNode[];
  parent: TestNode | null;
  scrollTop: number;
  clientHeight: number;
  clientTop: number;
  offsetHeight: number;
  scrollIntoView: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  getRootNode: () => Node;
  getBoundingClientRect: () => { top: number; bottom: number; left: number; width: number };
  querySelectorAll: (selector: string) => TestNode[];
  querySelector: (selector: string) => TestNode | null;
}
function find(root: TestNode, selector: string): TestNode[] {
  const matches = selector.startsWith('.')
    ? selector.slice(1).split('.').every(c => String(root.props.class ?? '').split(' ').includes(c))
    : root.type === selector;
  return [...(matches ? [root] : []), ...root.children.flatMap(child => find(child, selector))];
}
function node(type: string): TestNode {
  const result: TestNode = {
    type, props: {}, children: [], parent: null, scrollTop: 0, clientHeight: type === 'ul' ? 240 : 400, clientTop: 1, offsetHeight: 120,
    // 模拟 scrollIntoView 连带滚动宿主页面；此前实现会因此立即关闭菜单。
    scrollIntoView: vi.fn(() => listeners.get('scroll')?.({ composedPath: () => [] })), focus: vi.fn(),
    getRootNode: () => document,
    getBoundingClientRect: () => {
      if (String(result.props.class ?? '').includes('bbi-select-menu')) {
        return { top: 138, bottom: 380, left: 20, width: 180 };
      }
      if (String(result.props.class ?? '').includes('bbi-select-option')) {
        const items = result.parent!.querySelectorAll('.bbi-select-option');
        const top = 139 + items.indexOf(result) * 34 - result.parent!.scrollTop;
        return { top, bottom: top + 34, left: 20, width: 180 };
      }
      return {
        top: type === 'button' || String(result.props.class ?? '').includes('am-scroll') ? 100 : 1500,
        bottom: 134, left: 20, width: 180,
      };
    },
    querySelectorAll: selector => result.children.flatMap(child => find(child, selector)),
    querySelector: selector => result.querySelectorAll(selector)[0] ?? null,
  };
  return markRaw(result);
}
function remove(child: TestNode) {
  if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
  child.parent = null;
}
const renderer = createRenderer<TestNode, TestNode>({
  createElement: node, createText: () => node('#text'), createComment: () => node('#comment'),
  setText: () => {}, setElementText: target => { target.children = []; },
  patchProp: (target, key, _previous, value) => { target.props[key] = value; },
  parentNode: target => target.parent,
  nextSibling: target => target.parent?.children[(target.parent.children.indexOf(target) + 1)] ?? null,
  insert: (child, parent, anchor) => {
    remove(child);
    parent.children.splice(anchor ? parent.children.indexOf(anchor) : parent.children.length, 0, child);
    child.parent = parent;
  },
  remove,
  insertStaticContent: (_content, parent) => {
    const child = node('#static');
    child.parent = parent;
    parent.children.push(child);
    return [child, child];
  },
});
let app: ReturnType<typeof renderer.createApp>;
let root: TestNode;
let listeners: Map<string, (event: any) => void>;
let windowListeners: Map<string, (event: any) => void>;
let viewportListeners: Map<string, (event: any) => void>;
function mount(render: () => any) {
  root = node('root');
  app = renderer.createApp({ render });
  app.provide(ssrContextKey, {});
  app.mount(root);
}
beforeEach(() => {
  listeners = new Map();
  windowListeners = new Map();
  viewportListeners = new Map();
  vi.stubGlobal('document', {
    addEventListener: (type: string, fn: (event: any) => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
  });
  vi.stubGlobal('window', {
    innerHeight: 800,
    addEventListener: (type: string, fn: (event: any) => void) => windowListeners.set(type, fn),
    removeEventListener: (type: string) => windowListeners.delete(type),
    visualViewport: {
      addEventListener: (type: string, fn: (event: any) => void) => viewportListeners.set(type, fn),
      removeEventListener: (type: string) => viewportListeners.delete(type),
    },
  });
  settings.nai.artistPresets = Array.from({ length: 50 }, (_, i) => ({
    id: `art_${i}`, name: `Artist ${i}`, prompt: 'artist:a', quality: '', negative: '',
  }));
  settings.nai.activeArtistId = 'art_49';
});
afterEach(() => { app?.unmount(); vi.unstubAllGlobals(); });

describe('current artist navigation', () => {
  it('scrolls to the current dropdown option on every open and keeps internal scrolling open', async () => {
    const state = reactive({ value: 'art_49' });
    mount(() => h(Select, { modelValue: state.value, options: settings.nai.artistPresets.map(p => ({ value: p.id, label: p.name })) }));
    const trigger = find(root, 'button')[0];
    trigger.props.onClick();
    await nextTick();
    const menu = find(root, '.bbi-select-menu')[0];
    const options = find(root, '.bbi-select-option');
    expect(menu).toBeDefined();
    expect(menu.scrollTop).toBe(50 * 34 - menu.clientHeight);
    expect(options[49].scrollIntoView).not.toHaveBeenCalled();
    listeners.get('scroll')!({ composedPath: () => [menu] });
    await nextTick();
    expect(find(root, '.bbi-select-menu')).toHaveLength(1);
    listeners.get('scroll')!({ composedPath: () => [] });
    await nextTick();
    expect(find(root, '.bbi-select-menu')).toHaveLength(1);
    trigger.props.onClick();
    await nextTick();
    expect(find(root, '.bbi-select-menu')).toHaveLength(0);
    state.value = 'art_30';
    await nextTick();
    trigger.props.onClick();
    await nextTick();
    expect(find(root, '.bbi-select-menu')[0].scrollTop).toBe(31 * 34 - menu.clientHeight);
  });

  it('repositions instead of closing on background scrolling and iOS viewport changes', async () => {
    mount(() => h(Select, { modelValue: 'art_49', options: settings.nai.artistPresets.map(p => ({ value: p.id, label: p.name })) }));
    const trigger = find(root, 'button')[0];
    trigger.props.onClick();
    await nextTick();
    const menu = find(root, '.bbi-select-menu')[0];
    const scrollTop = menu.scrollTop;
    trigger.getBoundingClientRect = () => ({ top: 200, bottom: 234, left: 20, width: 180 });
    const event = { composedPath: () => [] };
    listeners.get('scroll')!(event);
    await nextTick();
    expect(find(root, '.bbi-select-menu')[0]).toBe(menu);
    windowListeners.get('resize')!(event);
    await nextTick();
    expect(find(root, '.bbi-select-menu')[0]).toBe(menu);
    viewportListeners.get('resize')!(event);
    viewportListeners.get('scroll')!(event);
    await nextTick();
    expect(find(root, '.bbi-select-menu')[0]).toBe(menu);
    expect(menu.props.style.top).toBe('238px');
    expect(menu.scrollTop).toBe(scrollTop);
    // 外部点击仍可取消，并移除窗口及 visualViewport 监听。
    listeners.get('pointerdown')!(event);
    await nextTick();
    expect(find(root, '.bbi-select-menu')).toHaveLength(0);
    expect(windowListeners.size).toBe(0);
    expect(viewportListeners.size).toBe(0);
  });

  it('removes Shadow DOM scroll listeners when unmounted with an open menu', async () => {
    mount(() => h(Select, { modelValue: 'art_0', options: [{ value: 'art_0', label: 'Artist 0' }] }));
    const shadowListeners = new Map<string, (event: any) => void>();
    const shadow = {
      addEventListener: (type: string, fn: (event: any) => void) => shadowListeners.set(type, fn),
      removeEventListener: (type: string) => shadowListeners.delete(type),
    };
    const trigger = find(root, 'button')[0];
    trigger.getRootNode = () => shadow as unknown as Node;
    trigger.props.onClick();
    await nextTick();
    expect(shadowListeners.has('scroll')).toBe(true);
    app.unmount();
    expect(shadowListeners.size).toBe(0);
    expect(listeners.size).toBe(0);
    expect(windowListeners.size).toBe(0);
    expect(viewportListeners.size).toBe(0);
  });

  it('keeps keyboard navigation inside the menu and leaves visible options still', async () => {
    mount(() => h(Select, { modelValue: 'art_0', options: settings.nai.artistPresets.map(p => ({ value: p.id, label: p.name })) }));
    find(root, 'button')[0].props.onClick();
    await nextTick();
    const menu = find(root, '.bbi-select-menu')[0];
    expect(menu.scrollTop).toBe(0);
    const key = async (value: string) => {
      listeners.get('keydown')!({ key: value, preventDefault: vi.fn(), stopPropagation: vi.fn() });
      await nextTick();
    };
    await key('ArrowDown');
    expect(menu.scrollTop).toBe(0);
    await key('End');
    expect(menu.scrollTop).toBe(50 * 34 - menu.clientHeight);
    await key('Home');
    expect(menu.scrollTop).toBe(0);
    expect(find(root, '.bbi-select-menu')).toHaveLength(1);
    expect(find(root, '.bbi-select-option').every(option => !option.scrollIntoView.mock.calls.length)).toBe(true);
    await key('Escape');
    expect(find(root, '.bbi-select-menu')).toHaveLength(0);
  });

  it('centers the active library card on reopen and resets to the top when no artist is used', async () => {
    const state = reactive({ open: false });
    mount(() => h(Manager, { open: state.open }));
    state.open = true;
    await nextTick();
    await nextTick();
    let area = find(root, '.am-scroll')[0];
    const active = find(root, '.am-card.is-active')[0];
    expect(active).toBeDefined();
    expect(area.scrollTop).toBe(1260);
    expect(settings.nai.activeArtistId).toBe('art_49');
    state.open = false;
    await nextTick();
    settings.nai.activeArtistId = '';
    state.open = true;
    await nextTick();
    await nextTick();
    area = find(root, '.am-scroll')[0];
    expect(area.scrollTop).toBe(0);
    expect(find(root, '.am-card.is-active')).toHaveLength(0);
  });
});
