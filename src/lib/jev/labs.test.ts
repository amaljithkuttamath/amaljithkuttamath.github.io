import { describe, expect, it } from 'vitest';
import { buildLabRequest, validateLabResponse, reviewDecision } from './labs';

const task = { id: 'sample', primary: 'label', fields: [{ id: 'text', label: 'Text', maxLength: 100 }], questions: { label: { type: 'choice', instructions: 'Choose', criteria: { a: 'A', b: 'B' } }, flag: { type: 'noul', instructions: 'Yes?' }, degree: { type: 'score', instructions: 'Degree?', criteria: ['Low', 'Medium', 'High'] } } };
const response = { answers: { label: { type: 'choice', choice: 'a', confidence: .7, probabilities: { a: .7, b: .3 } }, flag: { type: 'noul', noul: .8 }, degree: { type: 'score', score: 1.2, probabilities: { '0': .1, '1': .6, '2': .3 } } } };
describe('classification lab boundary', () => {
  it('builds state only from the task fields and rejects missing input', () => {
    expect(buildLabRequest(task, { text: ' Review ' }).state).toEqual({ text: 'Review' });
    expect(() => buildLabRequest(task, { text: '' })).toThrow();
    expect(() => buildLabRequest(task, { text: 'x'.repeat(101) })).toThrow();
  });
  it('accepts all three typed answer primitives', () => expect(validateLabResponse(task, response)).toBe(true));
  it.each([
    { answers: {} },
    { answers: { ...response.answers, flag: { type: 'noul', noul: 4 } } },
    { answers: { ...response.answers, label: { type: 'choice', choice: 'fake', probabilities: { a: .7, b: .3 } } } },
    { answers: { ...response.answers, degree: { type: 'score', score: 5, probabilities: { '0': .1, '1': .6, '2': .3 } } } },
    { answers: { ...response.answers, label: { type: 'choice', choice: 'a', probabilities: { a: .7 } } } },
    { answers: { ...response.answers, label: { type: 'choice', choice: 'b', probabilities: { a: .7, b: .3 } } } },
  ])('rejects malformed outputs before rendering: %j', raw => expect(validateLabResponse(task, raw)).toBe(false));
  it('routes an uncertain classification to review without changing its predicted label', () => {
    expect(reviewDecision(response.answers.label, .8)).toEqual({ label: 'a', probability: .7, review: true });
    expect(reviewDecision(response.answers.label, .6).review).toBe(false);
  });
});

import catalog from '../../data/jev/labs.json';
import recorded from '../../data/jev/lab-recordings.json';
import { leadComposite, type Lab } from './labs';
describe('published classification records', () => {
  for (const task of catalog as unknown as Lab[]) for (const example of task.examples) {
    it(`${task.id}/${example.id} has real, valid answers for the exact current prompt`, () => {
      const record = recorded.find(r => r.task === task.id && r.example === example.id);
      expect(record).toBeDefined();
      expect(record?.request).toEqual(buildLabRequest(task, example.inputs));
      expect(validateLabResponse(task, record?.response)).toBe(true);
    });
  }
  it('computes lead quality with explicit normalized weights, not confidence', () => {
    expect(leadComposite({ fit: { type: 'score', score: 3 }, intent: { type: 'score', score: 0 }, timing: { type: 'score', score: 0 } })).toBe(50);
  });
});
