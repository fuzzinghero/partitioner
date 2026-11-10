import AnalyzerWorker from '@fuzzinghero/partitioner/worker?worker';
import { verify } from './app.js';
try {
  await verify();
  await verify(() => new AnalyzerWorker());
  window.consumerResult = { ok: true };
} catch (error) {
  window.consumerResult = { ok: false, error: error.message };
}
