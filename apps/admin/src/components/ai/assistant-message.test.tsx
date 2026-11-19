import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AssistantMessage } from './assistant-message';
import type { AiAssistantMessage } from './assistant-provider';

const base: AiAssistantMessage = {
  id: 'a1',
  role: 'assistant',
  text: 'Which one?',
  status: 'complete',
  sources: [],
  followUp: { question: 'When should this be due?', choices: ['Tomorrow', 'No due date'] },
};

describe('a follow-up question laid out as options', () => {
  it('names each option by its words alone (the number is decoration) and answers on a click', () => {
    const onAnswerChoice = vi.fn();
    render(<AssistantMessage message={base} onAnswerChoice={onAnswerChoice} />);
    const section = screen.getByRole('region', { name: 'Clarifying question' });
    expect(section.textContent).toContain('When should this be due?');
    expect(screen.getByText('Choose an option or type your own answer.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'No due date' }));
    expect(onAnswerChoice).toHaveBeenCalledWith('No due date');
    expect(screen.getByRole('button', { name: 'Tomorrow' })).toBeTruthy();
  });

  it('shows the options but disables them while no answer can be sent', () => {
    render(<AssistantMessage message={base} />);
    for (const name of ['Tomorrow', 'No due date']) {
      expect(screen.getByRole('button', { name }).hasAttribute('disabled')).toBe(true);
    }
  });
});

describe('answer lines keep their words', () => {
  it('an error answer says it in plain words, with no code', () => {
    render(
      <AssistantMessage
        message={{ ...base, followUp: undefined, text: '', status: 'error', error: 'offline' }}
      />,
    );
    expect(screen.getByText(/Couldn’t reach the CRM to answer/)).toBeTruthy();
  });

  it('the compact answer (side panel) and the page answer both render the same words', () => {
    const message = { ...base, followUp: undefined, text: 'Five leads need you.' };
    const { rerender } = render(<AssistantMessage message={message} compact />);
    expect(screen.getByText('Five leads need you.')).toBeTruthy();
    rerender(<AssistantMessage message={message} />);
    expect(screen.getByText('Five leads need you.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy answer' })).toBeTruthy();
  });
});
