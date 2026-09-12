export type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in e && k !== 'list') (e as any)[k] = v;
    else e.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    e.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

export function option(value: string, label: string, selected = false): HTMLOptionElement {
  return el('option', { value, selected }, label);
}

export function labeled(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return el('label', { class: 'field' }, el('span', { class: 'field-label' }, label), control, hint ? el('span', { class: 'hint' }, hint) : null);
}

export function section(title: string, ...children: Child[]): HTMLElement {
  const body = el('div', { class: 'section-body' }, ...children);
  const head = el('div', { class: 'section-head', onClick: () => body.classList.toggle('collapsed') }, title);
  return el('div', { class: 'section' }, head, body);
}

export function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
