/**
 * ActivityCard interaction tests — keyboard handling, button-in-button,
 * stopPropagation behavior.
 *
 * Bead: nucleus-phone-xdh
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

// Mock framer-motion — replace motion.div with plain div, pass through props
jest.mock('framer-motion', () => {
  const R = require('react');
  return {
    motion: {
      div: R.forwardRef(({ children, whileHover, whileTap, layout, ...props }, ref) => (
        R.createElement('div', { ...props, ref }, children)
      )),
    },
    AnimatePresence: ({ children }) => children,
  };
});

// Mock react-router-dom
const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

import { ActivityCard } from '../Activity';

const baseCall = {
  id: 1,
  lead_name: 'John Smith',
  lead_company: 'Acme Corp',
  lead_phone: '+15551234567',
  disposition: 'connected',
  duration_seconds: 120,
  created_at: new Date().toISOString(),
  ai_summary: 'Discussed compressor needs for their CNC shop.',
  products_discussed: ['VSD Compressor'],
  caller_identity: 'alex',
};

describe('ActivityCard', () => {
  beforeEach(() => {
    mockNavigate.mockReset();
  });

  it('renders call details', () => {
    const onOpen = jest.fn();
    render(<ActivityCard call={baseCall} onOpen={onOpen} selected={false} />);

    expect(screen.getByText('John Smith')).toBeInTheDocument();
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
  });

  it('calls onOpen when card is clicked', async () => {
    const onOpen = jest.fn();
    render(<ActivityCard call={baseCall} onOpen={onOpen} selected={false} />);

    const card = screen.getByRole('button', { name: /John Smith/i });
    await userEvent.click(card);
    expect(onOpen).toHaveBeenCalledWith(baseCall);
  });

  it('calls onOpen on Enter key', () => {
    const onOpen = jest.fn();
    render(<ActivityCard call={baseCall} onOpen={onOpen} selected={false} />);

    const card = screen.getByRole('button', { name: /John Smith/i });
    fireEvent.keyDown(card, { key: 'Enter', target: card });
    expect(onOpen).toHaveBeenCalledWith(baseCall);
  });

  it('calls onOpen on Space key', () => {
    const onOpen = jest.fn();
    render(<ActivityCard call={baseCall} onOpen={onOpen} selected={false} />);

    const card = screen.getByRole('button', { name: /John Smith/i });
    fireEvent.keyDown(card, { key: ' ', target: card });
    expect(onOpen).toHaveBeenCalledWith(baseCall);
  });

  it('does NOT fire onOpen when Space originates from inner button (button-in-button guard)', () => {
    const onOpen = jest.fn();
    render(<ActivityCard call={baseCall} onOpen={onOpen} selected={false} />);

    const cockpitBtn = screen.getByRole('button', { name: /cockpit/i });

    // Dispatch keydown directly on the inner button — it bubbles to the card
    // but the card's handleKeyDown checks e.target !== e.currentTarget
    const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true });
    cockpitBtn.dispatchEvent(event);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('cockpit button navigates without triggering card onOpen', async () => {
    const onOpen = jest.fn();
    render(<ActivityCard call={baseCall} onOpen={onOpen} selected={false} />);

    const cockpitBtn = screen.getByRole('button', { name: /cockpit/i });
    await userEvent.click(cockpitBtn);

    // Cockpit button navigates
    expect(mockNavigate).toHaveBeenCalledWith(
      `/cockpit/${encodeURIComponent(baseCall.lead_phone)}`
    );

    // Card's onOpen should NOT fire (stopPropagation)
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('does not render cockpit button when no phone or email', () => {
    const onOpen = jest.fn();
    const callNoContact = { ...baseCall, lead_phone: null, lead_email: undefined };
    render(<ActivityCard call={callNoContact} onOpen={onOpen} selected={false} />);

    expect(screen.queryByRole('button', { name: /cockpit/i })).not.toBeInTheDocument();
  });

  it('reflects selected state via aria-pressed', () => {
    const onOpen = jest.fn();
    const { rerender } = render(
      <ActivityCard call={baseCall} onOpen={onOpen} selected={false} />
    );
    const card = screen.getByRole('button', { name: /John Smith/i });
    expect(card).toHaveAttribute('aria-pressed', 'false');

    rerender(<ActivityCard call={baseCall} onOpen={onOpen} selected={true} />);
    expect(card).toHaveAttribute('aria-pressed', 'true');
  });
});
