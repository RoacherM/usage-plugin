/**
 * Browser half: a "用量" entry in the left sidebar opening the usage dashboard.
 */
import React from 'react';
import { DICT } from './i18n.jsx';
import { makeUsagePage } from './page.jsx';
import { CSS } from './styles.js';

const PKG = '@local/dsh-usage';
const NS = 'local-usage';
const PANEL_ID = 'local-usage';

export const inject = ['slots', 'locale'];

function UsageIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20h16" />
      <path d="M6.5 16.5v-5M11 16.5V6.5M15.5 16.5v-7M20 16.5V4" />
    </svg>
  );
}

export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh: { panel: DICT.zh.panel }, en: { panel: DICT.en.panel } }), 'dsh-usage: dictionary');
  const t = ctx.locale.bind(NS);
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = PKG;
    style.textContent = CSS;
    document.head.appendChild(style);
    return () => style.remove();
  }, 'dsh-usage: styles');

  const openSession = (sessionId) => {
    const workspace = ctx.get('uiWorkspace');
    ctx.get('layout')?.selectPanel(null);
    if (workspace) workspace.openSession(sessionId);
  };
  const UsagePage = makeUsagePage({ openSession, locale: ctx.locale });

  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, UsagePage)), 'dsh-usage: page');
  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: 11, locale: NS, label: () => t('panel'),
  }, UsageIcon)), 'dsh-usage: sidebar entry');
}
