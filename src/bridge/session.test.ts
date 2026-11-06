import { describe, expect, it } from 'vitest';
import { isNoMoreResponse } from '../orchestration/statemachine.js';
import { classifyUserTurn } from './session.js';

describe('patient turn classification', () => {
  it('accepts vague but meaningful natural answers', () => {
    expect(classifyUserTurn('Sometimes.')).toBe('answer');
    expect(classifyUserTurn('A lot of times.')).toBe('answer');
    expect(classifyUserTurn('Not very much.')).toBe('answer');
  });

  it('separates repair requests and backchannels from answers', () => {
    expect(classifyUserTurn('Hello?')).toBe('repair');
    expect(classifyUserTurn('Can you repeat that?')).toBe('repair');
    expect(classifyUserTurn("I didn't hear you.")).toBe('repair');
    expect(classifyUserTurn('Yeah.')).toBe('backchannel');
    expect(classifyUserTurn('No.', true)).toBe('answer');
  });

  it('keeps patient questions out of questionnaire answers', () => {
    expect(classifyUserTurn('What does shortness of breath mean?')).toBe('patient-question');
    expect(classifyUserTurn('Can you explain that medication?')).toBe('patient-question');
    expect(classifyUserTurn('Whenever I climb the stairs.')).toBe('answer');
    expect(classifyUserTurn('Maybe every day?')).toBe('answer');
    expect(classifyUserTurn('How can I put it — a lot of times.')).toBe('answer');
    expect(classifyUserTurn('I use it every day — can you tell me whether that is too much?')).toBe(
      'patient-question',
    );
  });
});

describe('natural end-of-call responses', () => {
  it('accepts the live call response without requiring another acknowledgement', () => {
    expect(isNoMoreResponse('No. Thank you.')).toBe(true);
  });

  it('does not mistake a real concern for the end of the call', () => {
    expect(isNoMoreResponse('No, my current medication is not working.')).toBe(false);
  });
});
