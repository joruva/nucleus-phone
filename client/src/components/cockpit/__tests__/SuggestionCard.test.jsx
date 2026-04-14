import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SuggestionCard from '../SuggestionCard';

describe('SuggestionCard', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  // Null/empty guard is enforced by the parent (ConversationNavigator
  // conditionally renders), so SuggestionCard assumes a valid suggestion.

  test('renders suggestion text and source badge', () => {
    render(
      <SuggestionCard
        suggestion={{ text: 'Ask about their maintenance schedule', source: 'prediction', _receivedAt: 1 }}
        onDismiss={() => {}}
      />
    );
    expect(screen.getByText(/maintenance schedule/)).toBeInTheDocument();
    expect(screen.getByText(/predicted/i)).toBeInTheDocument();
  });

  test('auto-dismiss fires at 30s', () => {
    const onDismiss = jest.fn();
    render(
      <SuggestionCard
        suggestion={{ text: 'Test', _receivedAt: 1 }}
        onDismiss={onDismiss}
      />
    );
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => { jest.advanceTimersByTime(29_999); });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => { jest.advanceTimersByTime(1); });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test('replacement (new _receivedAt) resets the auto-dismiss timer', () => {
    const onDismiss = jest.fn();
    const { rerender } = render(
      <SuggestionCard suggestion={{ text: 'first', _receivedAt: 1 }} onDismiss={onDismiss} />
    );
    act(() => { jest.advanceTimersByTime(25_000); });
    rerender(
      <SuggestionCard suggestion={{ text: 'second', _receivedAt: 2 }} onDismiss={onDismiss} />
    );
    // Old timer cleaned up; we're now 25s into a new 30s window
    act(() => { jest.advanceTimersByTime(29_000); });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => { jest.advanceTimersByTime(1_000); });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test('dismiss button calls onDismiss', async () => {
    jest.useRealTimers();
    const user = userEvent.setup();
    const onDismiss = jest.fn();
    render(
      <SuggestionCard suggestion={{ text: 'hi', _receivedAt: 1 }} onDismiss={onDismiss} />
    );
    await user.click(screen.getByLabelText(/dismiss/i));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test('trigger value is exposed via data-trigger for styling hooks/tests', () => {
    const exit = render(
      <SuggestionCard
        suggestion={{ text: 'Graceful exit', trigger: 'exit_assist', _receivedAt: 1 }}
        onDismiss={() => {}}
      />
    );
    expect(exit.container.firstChild.getAttribute('data-trigger')).toBe('exit_assist');

    const objection = render(
      <SuggestionCard
        suggestion={{ text: 'Rebuttal', trigger: 'objection', _receivedAt: 2 }}
        onDismiss={() => {}}
      />
    );
    expect(objection.container.firstChild.getAttribute('data-trigger')).toBe('objection');

    const plain = render(
      <SuggestionCard
        suggestion={{ text: 'Ask about budget', _receivedAt: 3 }}
        onDismiss={() => {}}
      />
    );
    expect(plain.container.firstChild.getAttribute('data-trigger')).toBe('default');
  });

  test('auto-dismiss reads latest onDismiss via ref (inline callbacks stay safe)', () => {
    const first = jest.fn();
    const second = jest.fn();
    // _receivedAt is stable — effect does not re-run even though onDismiss changes.
    const { rerender } = render(
      <SuggestionCard suggestion={{ text: 'hi', _receivedAt: 1 }} onDismiss={first} />
    );
    rerender(
      <SuggestionCard suggestion={{ text: 'hi', _receivedAt: 1 }} onDismiss={second} />
    );
    act(() => { jest.advanceTimersByTime(30_000); });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
