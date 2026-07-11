export interface PasswordRequirement {
  id: 'length' | 'lowercase' | 'uppercase' | 'digit' | 'symbol';
  label: string;
  isMet: boolean;
}

const SYMBOL_PATTERN = /[^A-Za-z0-9]/;

export function getPasswordRequirements(password: string): PasswordRequirement[] {
  return [
    {
      id: 'length',
      label: '8 or more characters',
      isMet: password.length >= 8,
    },
    {
      id: 'lowercase',
      label: 'One lowercase letter',
      isMet: /[a-z]/.test(password),
    },
    {
      id: 'uppercase',
      label: 'One uppercase letter',
      isMet: /[A-Z]/.test(password),
    },
    {
      id: 'digit',
      label: 'One number',
      isMet: /\d/.test(password),
    },
    {
      id: 'symbol',
      label: 'One symbol',
      isMet: SYMBOL_PATTERN.test(password),
    },
  ];
}

export function isPasswordValid(password: string): boolean {
  return getPasswordRequirements(password).every((requirement) => requirement.isMet);
}

export function getPasswordValidationMessage(password: string): string | null {
  const missing = getPasswordRequirements(password)
    .filter((requirement) => !requirement.isMet)
    .map((requirement) => requirement.label.toLowerCase());

  if (missing.length === 0) {
    return null;
  }

  return `Your password needs ${missing.join(', ')}.`;
}
