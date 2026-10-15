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
  offsetHeight: number;
  scrollIntoView: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
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
    type, props: {}, children: [], parent: null, scrollTop: 0, clientHeight: 400, offsetHeight: 120,
    scrollIntoView: vi.fn(), focus: vi.fn(),
    getBoundingClientRect: () => ({
      top: type === 'button' || String(result.props.class ?? '').includes('am-scroll') ? 100 : 1500,
      bottom: 134, left: 20, width: 180,
    }),
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
function mount(render: () => any) {
  root = node('root');
  app = renderer.createApp({ render });
  app.provide(ssrContextKey, {});
  app.mount(root);
}
beforeEach(() => {
  listeners = new Map();
  vi.stubGlobal('document', {
    addEventListener: (type: string, fn: (event: any) => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
  });
  vi.stubGlobal('window', { innerHeight: 800, addEventListener: vi.fn(), removeEventListener: vi.fn() });
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
    expect(options[49].scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    listeners.get('scroll')!({ composedPath: () => [menu] });
    await nextTick();
    expect(find(root, '.bbi-select-menu')).toHaveLength(1);
    listeners.get('scroll')!({ composedPath: () => [] });
    await nextTick();
    expect(find(root, '.bbi-select-menu')).toHaveLength(0);
    state.value = 'art_30';
    await nextTick();
    trigger.props.onClick();
    await nextTick();
    expect(find(root, '.bbi-select-option')[30].scrollIntoView).toHaveBeenCalled();
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
