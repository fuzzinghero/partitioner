import { verify } from './app.js';
try {
  await verify();
  window.consumerResult = { ok: true };
} catch (error) {
  window.consumerResult = { ok: false, error: error.message };
}
