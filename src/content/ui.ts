import type { OptimizerStats } from '../shared/types';
import { t } from '../shared/i18n';

const HOST_ID = 'cgpt-optimizer-status-host';

export class StatusSurface {
  private host: HTMLDivElement | null = null;
  private content: HTMLDivElement | null = null;

  update(stats: OptimizerStats, enabled: boolean, show: boolean): void {
    if (!show || !enabled) {
      this.destroy();
      return;
    }

    if (!this.host || !this.content || !this.host.isConnected) this.create();
    if (!this.content) return;
    this.content.textContent = t('statusOverlayText', String(stats.active), String(stats.turns), String(stats.longTasks));
  }

  destroy(): void {
    this.host?.remove();
    this.host = null;
    this.content = null;
  }

  private create(): void {
    this.destroy();
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('aria-live', 'polite');
    host.setAttribute('aria-label', t('statusOverlayLabel'));
    const shadow = host.attachShadow({ mode: 'closed' });
    const content = document.createElement('div');
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      div { position: fixed; z-index: 2147483647; right: 12px; bottom: 12px; padding: 6px 9px;
        border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); border-radius: 999px;
        background: color-mix(in srgb, Canvas 92%, CanvasText); color: CanvasText;
        font: 11px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; box-shadow: 0 2px 10px rgb(0 0 0 / 12%); }
      @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
    `;
    shadow.append(style, content);
    document.documentElement.append(host);
    this.host = host;
    this.content = content;
  }
}
