export interface LoreEntry { id: string; name: string; keys: string[]; secondaryKeys: string[]; content: string; enabled: boolean; always: boolean; matchAll: boolean; caseSensitive: boolean; priority: number }
export interface StoryPortrait { id: string; name: string; image: string; voice: string; motion: 'none' | 'breathe' | 'bounce' | 'sway' }
export type PromptField = 'description' | 'examples' | 'instructions' | 'postHistory' | 'characterNote' | 'persona' | 'authorNotes' | 'lore';
export interface PromptPlacement { position: 'before' | 'after' | 'depth'; role: 'system' | 'user' | 'assistant'; depth: number }
export interface AdditionalInstruction { id: string; name: string; content: string; enabled: boolean; placement: PromptPlacement; source: '' | 'instructions' | 'postHistory' | 'characterNote' }
export const defaultPlacements = (): Record<PromptField, PromptPlacement> => ({
  description: { position: 'before', role: 'user', depth: 0 }, examples: { position: 'before', role: 'user', depth: 0 },
  instructions: { position: 'before', role: 'system', depth: 0 }, postHistory: { position: 'after', role: 'system', depth: 0 },
  characterNote: { position: 'depth', role: 'system', depth: 4 }, persona: { position: 'before', role: 'user', depth: 0 },
  authorNotes: { position: 'before', role: 'user', depth: 0 }, lore: { position: 'before', role: 'user', depth: 0 },
});
export interface StorySetup {
  name: string; description: string; examples: string;
  instructions: string; postHistory: string; characterNote: string; prefill: string; greetings: string[];
  placements: Record<PromptField, PromptPlacement>; importedCard: string;
  additionalInstructions: AdditionalInstruction[];
  personaName: string; persona: string; authorNotes: string; lore: LoreEntry[];
  portraits: StoryPortrait[]; showPortraits: boolean; contextMessages: number; contextChars: number; loreBudget: number;
}
export const blankStory = (): StorySetup => ({ name: '', description: '', examples: '', instructions: '', postHistory: '', characterNote: '', prefill: '', greetings: [], placements: defaultPlacements(), additionalInstructions: [], importedCard: '', personaName: '', persona: '', authorNotes: '', lore: [], portraits: [], showPortraits: false, contextMessages: 40, contextChars: 48000, loreBudget: 12000 });
