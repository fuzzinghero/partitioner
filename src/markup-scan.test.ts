import { expect, it } from 'vitest';
import { lexicalDataSpans } from './markup-scan.js';
const data = (text: string) => lexicalDataSpans(text)?.map((s) => text.slice(s.start, s.end));
it('extracts only data spans while retaining source offsets and all literal framing', () => {
  const text =
    '<custom-art data-points="0,1 2,3"></custom-art><p>Blocked</p><script>write("private")</script>';
  const spans = lexicalDataSpans(text)!;
  expect(spans.map((s) => text.slice(s.start, s.end))).toEqual(['Blocked']);
  expect(text.slice(0, spans[0].start)).toBe('<custom-art data-points="0,1 2,3"></custom-art><p>');
  expect(text.slice(spans[0].end)).toBe('</p><script>write("private")</script>');
});
it.each([
  '<script>private</script>',
  '<style>private</style>',
  '<i data-value="private"></i>',
  '<!-- private -->',
  '<textarea>private</textarea>',
  '<title>private</title>',
  '<select><option>private</option></select>',
  '<template>private</template>',
  '<script><title></title>private</script>',
])('excludes program and markup bytes from data slots: %s', (suffix) => {
  expect(data('<p>visible</p>' + suffix)).toEqual(['visible']);
});
it.each([
  '<script><!--<script></script>',
  '<script>const x=1</script data-x>',
  '<!-- unsupported -- comment -->',
  '<!DOCTYPE html PUBLIC "somewhere">',
  '<p broken="unterminated>',
  '<script>unterminated',
  '<script><![CDATA[</script>private]]></script>',
])('retains ambiguous markup as unavailable: %s', (suffix) => {
  expect(lexicalDataSpans('<p>visible</p>' + suffix)).toBeUndefined();
});
it('bounds nested container scanning and excessive data spans', () => {
  expect(lexicalDataSpans('<title>'.repeat(200) + 'data' + '</title>'.repeat(200))).toBeUndefined();
  expect(lexicalDataSpans('<p>data</p>'.repeat(401))).toBeUndefined();
});
