import { render } from '@testing-library/react';
import SentimentArc, { scoreEntry } from '../SentimentArc';

describe('scoreEntry', () => {
  test('customer state determines base score', () => {
    expect(scoreEntry({ customer: 'positive', momentum: 'steady' })).toBe(1);
    expect(scoreEntry({ customer: 'neutral', momentum: 'steady' })).toBe(0);
    expect(scoreEntry({ customer: 'guarded', momentum: 'steady' })).toBe(-0.5);
    expect(scoreEntry({ customer: 'negative', momentum: 'steady' })).toBe(-1);
    expect(scoreEntry({ customer: 'hostile', momentum: 'steady' })).toBe(-2);
  });

  test('momentum nudges the score', () => {
    expect(scoreEntry({ customer: 'neutral', momentum: 'building' })).toBeCloseTo(0.3);
    expect(scoreEntry({ customer: 'neutral', momentum: 'declining' })).toBeCloseTo(-0.3);
    expect(scoreEntry({ customer: 'neutral', momentum: 'tanking' })).toBeCloseTo(-0.5);
  });

  test('score is clamped to [-2, 1.5]', () => {
    // positive + building = 1.3 (under cap)
    expect(scoreEntry({ customer: 'positive', momentum: 'building' })).toBeCloseTo(1.3);
    // hostile + tanking would be -2.5 but clamps to -2
    expect(scoreEntry({ customer: 'hostile', momentum: 'tanking' })).toBe(-2);
  });

  test('returns null for missing / unknown customer state', () => {
    expect(scoreEntry(null)).toBeNull();
    expect(scoreEntry({ customer: 'banana' })).toBeNull();
  });
});

describe('SentimentArc', () => {
  test('empty history renders baseline only (no path)', () => {
    const { container } = render(<SentimentArc history={[]} />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(container.querySelector('path')).toBeNull();
    expect(container.querySelector('line')).toBeTruthy();
  });

  test('renders arc path + head marker when history present', () => {
    const history = [
      { customer: 'neutral', momentum: 'steady' },
      { customer: 'positive', momentum: 'building' },
    ];
    const { container } = render(<SentimentArc history={history} />);
    // Two area fills + one line + one head circle
    expect(container.querySelectorAll('path').length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector('circle')).toBeTruthy();
  });

  test('head circle is green when latest score > 0, red when < 0', () => {
    const up = render(
      <SentimentArc history={[{ customer: 'positive', momentum: 'building' }]} />
    );
    const upFill = up.container.querySelector('circle').getAttribute('fill');
    expect(upFill).toMatch(/nav-positive/);

    const down = render(
      <SentimentArc history={[{ customer: 'hostile', momentum: 'tanking' }]} />
    );
    const downFill = down.container.querySelector('circle').getAttribute('fill');
    expect(downFill).toMatch(/nav-negative/);
  });

  test('degraded dims opacity', () => {
    const { container } = render(
      <SentimentArc history={[{ customer: 'neutral' }]} degraded={true} />
    );
    expect(container.querySelector('svg').style.opacity).toBe('0.5');
  });
});
