import type { ComponentProps } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { WorkflowAssistantDrawer } from '@/app/create-workflow/WorkflowPlannerDrawer';

describe('WorkflowAssistantDrawer', () => {
  function renderDrawer(overrides: Partial<ComponentProps<typeof WorkflowAssistantDrawer>> = {}) {
    const props: ComponentProps<typeof WorkflowAssistantDrawer> = {
      availability: 'ready',
      creditsLabel: '6 credits',
      error: null,
      input: '',
      isApplying: false,
      isDiscarding: false,
      isLoading: false,
      isOpen: false,
      isProposalStale: false,
      isSubmitting: false,
      messages: [],
      onApplyProposal: vi.fn(),
      onClose: vi.fn(),
      onDiscardProposal: vi.fn(),
      onInputChange: vi.fn(),
      onOpen: vi.fn(),
      onSendMessage: vi.fn(),
      proposal: null,
      setupMessage: null,
      ...overrides,
    };

    return {
      ...render(<WorkflowAssistantDrawer {...props} />),
      props,
    };
  }

  it('renders a floating bot trigger and opens from the top-right launcher', () => {
    const onOpen = vi.fn();

    renderDrawer({ onOpen });

    const trigger = screen.getByTestId('workflow-assistant-trigger');
    expect(trigger).toHaveAttribute('aria-label', 'Open AI Builder');
    expect(screen.queryByTestId('workflow-assistant-popup')).not.toBeInTheDocument();

    fireEvent.click(trigger);

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('shows a setup-required banner and disables proposal creation when assistant availability is blocked', () => {
    const onInputChange = vi.fn();

    renderDrawer({
      availability: 'setup_required',
      input: 'Build a Seedance 2.0 transformation workflow',
      isOpen: true,
      onInputChange,
      setupMessage: 'Workflow assistant database tables are missing. Run migration 20260416120000_workflow_canvas_assistant.sql.',
    });

    expect(screen.getByText('Setup required', { selector: 'div' })).toBeInTheDocument();
    expect(screen.getByText('Workflow assistant database tables are missing. Run migration 20260416120000_workflow_canvas_assistant.sql.')).toBeInTheDocument();
    expect(screen.getByTestId('workflow-assistant-popup')).toBeInTheDocument();

    const textarea = screen.getByLabelText('Workflow assistant prompt');
    expect(textarea).toBeDisabled();

    const buildButton = screen.getByRole('button', { name: 'Setup required' });
    expect(buildButton).toBeDisabled();
    expect(onInputChange).not.toHaveBeenCalled();
  });
});
