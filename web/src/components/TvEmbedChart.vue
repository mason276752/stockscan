<script setup>
// TradingView's official embeddable Advanced Chart widget, on TradingView's
// own data. A basket is charted as a "spread" symbol - a weighted sum of
// tickers such as 0.42*AAPL+0.4*MSFT+2.2*NVDA - which TradingView computes
// bar by bar (candles included); the benchmark rides along as a compare
// symbol. TradingView allows at most 10 tickers in one spread.
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps({
  expression: { type: String, required: true }, // spread symbol
  compare: { type: String, default: '' }, // second symbol / spread, on the same scale
  range: { type: String, default: '36M' }, // 12M | 36M | 60M | 120M | ALL
  colors: { type: String, default: 'tw' },
  height: { type: Number, default: 460 },
  volume: { type: Boolean, default: false }, // show the volume pane (single stocks; meaningless for a spread)
  symbolChange: { type: Boolean, default: false }, // let the user type another symbol in the widget
});

const EMBED = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';

const el = ref(null);
const failed = ref(false);
let timer = null;

function mount() {
  if (!el.value) return;
  el.value.innerHTML = '';
  failed.value = false;
  const up = props.colors === 'us' ? '#16a34a' : '#dc2626';
  const down = props.colors === 'us' ? '#dc2626' : '#16a34a';
  const cfg = {
    autosize: true,
    symbol: props.expression,
    interval: 'D',
    timezone: 'America/New_York',
    theme: 'light',
    style: '1',
    locale: 'zh_TW',
    allow_symbol_change: props.symbolChange,
    hide_volume: !props.volume,
    withdateranges: true,
    save_image: true,
    range: props.range,
    support_host: 'https://www.tradingview.com',
    overrides: {
      'mainSeriesProperties.candleStyle.upColor': up,
      'mainSeriesProperties.candleStyle.downColor': down,
      'mainSeriesProperties.candleStyle.borderUpColor': up,
      'mainSeriesProperties.candleStyle.borderDownColor': down,
      'mainSeriesProperties.candleStyle.wickUpColor': up,
      'mainSeriesProperties.candleStyle.wickDownColor': down,
    },
  };
  if (props.compare) cfg.compareSymbols = [{ symbol: props.compare, position: 'SameScale' }];
  const box = document.createElement('div');
  box.className = 'tradingview-widget-container';
  box.style.height = '100%';
  const s = document.createElement('script');
  s.src = EMBED;
  s.async = true;
  s.type = 'text/javascript';
  s.textContent = JSON.stringify(cfg);
  s.onerror = () => (failed.value = true);
  box.appendChild(s);
  el.value.appendChild(box);
}

// the widget rebuilds from scratch: coalesce quick successive prop changes
function remount() {
  clearTimeout(timer);
  timer = setTimeout(mount, 150);
}
onMounted(mount);
onBeforeUnmount(() => {
  clearTimeout(timer);
  if (el.value) el.value.innerHTML = '';
});
watch(() => [props.expression, props.compare, props.range, props.colors, props.volume, props.symbolChange], remount);
</script>

<template>
  <div class="tv">
    <div ref="el" class="frame" :style="{ height: `${height}px` }"></div>
    <p v-if="failed" class="muted small">載入不了 TradingView 的圖（需要能連到 tradingview.com）。</p>
  </div>
</template>

<style scoped>
.frame {
  width: 100%;
}
.small {
  font-size: 12px;
}
</style>
