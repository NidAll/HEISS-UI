export function formatTag(tag: string): string;
export function tagKey(tag: string): string;
export function displayName(tag: string): string;
export function composeTagPrompt(fields: Record<string, string[]>, options?: { head?: string[]; safety?: string; order?: string[] }): string;
