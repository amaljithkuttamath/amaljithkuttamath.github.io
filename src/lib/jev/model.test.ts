import { describe, expect, it } from 'vitest';
import { answerView, browserDecision, inspectDraft } from './model';

const original = {
  model: 'jev-latest', state: { target: 'app', post: 'Great.' },
  questions: { opinion: { type: 'choice', instructions: 'What attitude is expressed?', criteria: { positive: 'Approval', negative: 'Criticism' } } },
};

describe('editable recordings', () => {
  it('does not present a saved answer as the result of an edited input', () => {
    const result = inspectDraft('{"target":"app","post":"Awful."}', JSON.stringify(original.questions), original);
    expect(result.ok).toBe(true);
    expect(result.matchesRecording).toBe(false);
    expect(result.request?.state).toEqual({ target: 'app', post: 'Awful.' });
  });
  it('ignores whitespace and object-key order when identifying the original request', () => {
    expect(inspectDraft('{ "post": "Great.", "target": "app" }', JSON.stringify(original.questions, null, 2), original).matchesRecording).toBe(true);
  });
  it('invalidates recorded answers when the question meaning changes', () => {
    const changed = structuredClone(original.questions);
    changed.opinion.instructions = 'What attitude is quoted?';
    expect(inspectDraft(JSON.stringify(original.state), JSON.stringify(changed), original).matchesRecording).toBe(false);
  });
  it.each(['{', 'null', '[]', '{"q":{"type":"choice","instructions":"Choose","criteria":{}}}', '{"q":{"type":"score","instructions":"Rate","criteria":["Only"]}}'])('rejects invalid question maps instead of exporting a broken request: %s', (questions) => {
    expect(inspectDraft('{}', questions, original).ok).toBe(false);
  });
});

describe('typed answer presentation', () => {
  it('presents a Noul as probability of yes, without an invented confidence', () => {
    const view = answerView({ type: 'noul', instructions: 'Is it sarcastic?' }, { type: 'noul', noul: 0.97 });
    expect(view.value).toBe('97%');
    expect(view.caption).toBe('Probability of yes');
    expect(view.bars.map((b: any) => b.percent)).toEqual([97, 3]);
  });
  it('uses the ordered rubric as a Score scale, not a percentage or confidence', () => {
    const view = answerView({ type: 'score', instructions: 'Intensity?', criteria: ['Absent', 'Mild', 'Clear', 'Extreme'] }, { type: 'score', score: 2.17, confidence: 0.82, probabilities: { '0': 0, '1': 0, '2': 0.82, '3': 0.18 } });
    expect(view.value).toBe('2.17 / 3');
    expect(view.bars[2].label).toBe('Clear');
    expect(view.bars[2].percent).toBe(82);
  });
  it('ignores speculative target answers when the selected operation is done', () => {
    expect(browserDecision({ operation: { choice: 'done' }, click_target: { choice: 'e42' } }, [{ id: 'e42', label: 'Cancel subscription' }])).toEqual({ action: 'Done', detail: 'No click is consumed.' });
  });
});
