import { describe, it, expect } from 'vitest';
import { composeSearchText, extractSectionPath } from '../compose.js';

describe('composeSearchText', () => {
    it('joins sectionPath with " > " and appends content after a blank line', () => {
        const result = composeSearchText('Body text.', {
            sectionPath: ['Agents', 'Tools', 'Custom tools'],
        });
        expect(result).toBe('Agents > Tools > Custom tools\n\nBody text.');
    });

    it('returns content unchanged when sectionPath is missing (old collections)', () => {
        expect(composeSearchText('Body text.', { docPath: 'a.md' })).toBe('Body text.');
        expect(composeSearchText('Body text.')).toBe('Body text.');
    });

    it('ignores empty or invalid sectionPath arrays defensively', () => {
        expect(composeSearchText('Body.', { sectionPath: [] })).toBe('Body.');
        expect(composeSearchText('Body.', { sectionPath: ['', null, 3] })).toBe('Body.');
    });

    it('keeps valid string entries from a partially invalid array', () => {
        expect(composeSearchText('Body.', { sectionPath: ['Agents', 42, 'Tools'] })).toBe(
            'Agents > Tools\n\nBody.',
        );
    });
});

describe('extractSectionPath', () => {
    it('returns undefined for missing metadata or non-array values', () => {
        expect(extractSectionPath(undefined)).toBeUndefined();
        expect(extractSectionPath({ sectionPath: 'Agents' })).toBeUndefined();
    });

    it('filters to non-empty strings and returns undefined when nothing remains', () => {
        expect(extractSectionPath({ sectionPath: ['A', '', 'B'] })).toEqual(['A', 'B']);
        expect(extractSectionPath({ sectionPath: ['', ''] })).toBeUndefined();
    });
});
