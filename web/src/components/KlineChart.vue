<script setup lang="ts">
// Daily candlestick chart with an optional rebased overlay line (the
// benchmark). Two renderers: TradingView's Advanced Charts when the licensed
// library is installed (web/assets/tradingview/, served at /tradingview/;
// data through tvDatafeed.js), otherwise TradingView's open-source
// Lightweight Charts.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { CandlestickSeries, ColorType, CrosshairMode, LineSeries, createChart } from 'lightweight-charts';
import { makeDatafeed } from '../tvDatafeed';
import { url } from '../base';
import { locale, t } from '../i18n';
import { cssVar, isDark } from '../theme';

const props = defineProps({
  bars: { type: Array, default: () => [] }, // [{ time: 'YYYY-MM-DD', open, high, low, close }]
  overlay: { type: Array, default: () => [] }, // [{ time, value }]
  overlayLabel: { type: String, default: '' },
  label: { type: String, default: '' },
  colors: { type: String, default: 'tw' }, // 'tw' red up / green down | 'us' green up / red down
  advanced: { type: Boolean, default: false }, // TradingView Advanced Charts available (window.TradingView.widget)
  height: { type: Number, default: 440 },
});

const el = ref(null);
const hover = ref(null); // bar under the crosshair (+ overlay value)
let chart = null;
let candles = null;
let line = null;
let widget = null; // Advanced Charts
const usingAdvanced = ref(false);
let ro = null;

// the chart draws its own colours: the theme's tokens, re-read when it changes (isDark)
const UP = computed(() => isDark.value != null && cssVar(props.colors === 'us' ? '--up' : '--down'));
const DOWN = computed(() => isDark.value != null && cssVar(props.colors === 'us' ? '--down' : '--up'));

const byTime = computed(() => new Map(props.bars.map((b) => [b.time, b])));
const shown = computed(() => hover.value || (props.bars.length ? { ...props.bars.at(-1), overlay: props.overlay.at(-1)?.value ?? null, last: true } : null));
const prevClose = (bar) => {
  const i = props.bars.findIndex((b) => b.time === bar.time);
  return i > 0 ? props.bars[i - 1].close : null;
};
const f2 = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const pct = (v) => (v == null ? '' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`);
const change = computed(() => {
  if (!shown.value) return null;
  const p = prevClose(shown.value);
  return p ? shown.value.close / p - 1 : null;
});
const sinceStart = computed(() => (shown.value && props.bars.length ? shown.value.close / props.bars[0].close - 1 : null));

function seriesOptions() {
  return { upColor: UP.value, downColor: DOWN.value, borderUpColor: UP.value, borderDownColor: DOWN.value, wickUpColor: UP.value, wickDownColor: DOWN.value };
}

function mountLight() {
  chart = createChart(el.value, {
    height: props.height,
    layout: { background: { type: ColorType.Solid, color: cssVar('--panel') }, textColor: cssVar('--text'), fontFamily: 'inherit' },
    grid: { vertLines: { color: cssVar('--grid') }, horzLines: { color: cssVar('--grid') } },
    crosshair: { mode: CrosshairMode.Normal },
    rightPriceScale: { borderColor: cssVar('--border') },
    timeScale: { borderColor: cssVar('--border'), rightOffset: 3 },
    localization: { locale: locale.value === 'zh' ? 'zh-TW' : 'en-US' },
  });
  candles = chart.addSeries(CandlestickSeries, seriesOptions());
  line = chart.addSeries(LineSeries, { color: cssVar('--accent'), lineWidth: 1.5, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false });
  chart.subscribeCrosshairMove((p) => {
    if (!p.time || !p.point) {
      hover.value = null;
      return;
    }
    const bar = byTime.value.get(p.time);
    if (!bar) {
      hover.value = null;
      return;
    }
    const ov = p.seriesData.get(line);
    hover.value = { ...bar, overlay: ov?.value ?? null };
  });
  setData(true);
  ro = new ResizeObserver(() => chart && chart.applyOptions({ width: el.value.clientWidth }));
  ro.observe(el.value);
}

function setData(fit) {
  if (!candles) return;
  candles.setData(props.bars);
  line.setData(props.overlay);
  line.applyOptions({ visible: props.overlay.length > 0 });
  if (fit) chart.timeScale().fitContent();
}

// ---- TradingView Advanced Charts (only when the library is installed) ----
function mountAdvanced() {
  const TV = window.TradingView;
  if (!TV?.widget) return false;
  const name = props.label || t('nav.basket');
  const overlayName = props.overlay.length ? props.overlayLabel : '';
  widget = new TV.widget({
    container: el.value,
    library_path: url('/tradingview/charting_library/'),
    datafeed: makeDatafeed({ name, bars: () => props.bars, overlayName, overlay: () => props.overlay }),
    symbol: name,
    interval: 'D',
    locale: locale.value === 'zh' ? 'zh_TW' : 'en',
    timezone: 'America/New_York',
    autosize: true,
    theme: isDark.value ? 'dark' : 'light',
    // the datafeed only knows this basket (and its benchmark): no symbol search
    disabled_features: ['header_symbol_search', 'symbol_search_hot_key', 'header_compare', 'save_chart_properties_to_local_storage', 'create_volume_indicator_by_default'],
    enabled_features: ['hide_left_toolbar_by_default'],
    overrides: {
      'mainSeriesProperties.candleStyle.upColor': UP.value,
      'mainSeriesProperties.candleStyle.downColor': DOWN.value,
      'mainSeriesProperties.candleStyle.borderUpColor': UP.value,
      'mainSeriesProperties.candleStyle.borderDownColor': DOWN.value,
      'mainSeriesProperties.candleStyle.wickUpColor': UP.value,
      'mainSeriesProperties.candleStyle.wickDownColor': DOWN.value,
    },
  });
  el.value.style.height = `${props.height}px`;
  usingAdvanced.value = true;
  const w = widget;
  w.chartReady().then(() => {
    if (w !== widget) return;
    // the benchmark (already rebased to the basket's 100) as a line on the same scale
    if (overlayName) {
      w.activeChart()
        .createStudy('Overlay', true, false, { symbol: overlayName }, { style: 2, 'lineStyle.color': cssVar('--accent'), 'lineStyle.linewidth': 2, showPriceLine: false }, { priceScale: 'as-series', disableUndo: true })
        .catch(() => {});
    }
    // ten years of daily bars are already on hand: show the whole range at once
    const bars = props.bars;
    if (bars.length) w.activeChart().setVisibleRange({ from: Date.parse(`${bars[0].time}T00:00:00Z`) / 1000, to: Date.parse(`${bars.at(-1).time}T00:00:00Z`) / 1000 + 3 * 86400 }).catch(() => {});
  });
  return true;
}

function remount() {
  unmount();
  if (!(props.advanced && mountAdvanced())) mountLight();
}
function unmount() {
  ro?.disconnect();
  ro = null;
  if (widget) {
    try {
      widget.remove();
    } catch {
      /* already gone */
    }
    widget = null;
  }
  usingAdvanced.value = false;
  if (el.value) el.value.style.height = '';
  if (chart) {
    chart.remove();
    chart = null;
    candles = null;
    line = null;
  }
  hover.value = null;
}

onMounted(remount);
onBeforeUnmount(unmount);
watch(() => [props.bars, props.overlay], () => (widget ? remount() : setData(true)), { deep: false });
watch(() => props.colors, () => (widget ? remount() : candles?.applyOptions(seriesOptions())));
watch(() => props.advanced, remount);
watch(locale, remount);
watch(isDark, remount);
</script>

<template>
  <div class="kline">
    <div v-if="!usingAdvanced" class="legend">
      <template v-if="shown">
        <span class="lbl">{{ label }}</span>
        <span class="mono">{{ shown.time }}</span>
        <span>{{ t('kl.open') }} <b class="mono">{{ f2.format(shown.open) }}</b></span>
        <span>{{ t('kl.high') }} <b class="mono">{{ f2.format(shown.high) }}</b></span>
        <span>{{ t('kl.low') }} <b class="mono">{{ f2.format(shown.low) }}</b></span>
        <span>{{ t('kl.close') }} <b class="mono">{{ f2.format(shown.close) }}</b></span>
        <span v-if="change != null" class="mono" :class="change >= 0 ? 'up' : 'down'">{{ pct(change) }}</span>
        <span v-if="sinceStart != null" class="muted small">{{ t('kl.sinceStart') }} <b class="mono" :class="sinceStart >= 0 ? 'up' : 'down'">{{ pct(sinceStart) }}</b></span>
        <span v-if="overlay.length && shown.overlay != null" class="ov small"><i></i>{{ overlayLabel }} <b class="mono">{{ f2.format(shown.overlay) }}</b> <span class="muted">{{ pct(shown.overlay / 100 - 1) }}</span></span>
      </template>
    </div>
    <div ref="el" class="canvas"></div>
  </div>
</template>

<style scoped>
.kline {
  position: relative;
}
.canvas {
  width: 100%;
}
.legend {
  position: absolute;
  z-index: 2;
  left: 8px;
  top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  font-size: 12px;
  pointer-events: none;
  background: var(--overlay);
  padding: 2px 6px;
  border-radius: 4px;
}
.legend .lbl {
  font-weight: 600;
}
.up {
  color: v-bind(UP);
}
.down {
  color: v-bind(DOWN);
}
.ov i {
  display: inline-block;
  width: 14px;
  height: 2px;
  background: var(--accent);
  vertical-align: middle;
  margin-right: 4px;
}
</style>
