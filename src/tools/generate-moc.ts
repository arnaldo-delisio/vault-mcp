/**
 * generate_moc Tool - Manual Map of Content generation
 *
 * Allows users to manually generate or regenerate MOCs for any topic.
 * Automatically called by save_learning when threshold reached.
 */

import { MOCGenerator } from '../services/moc-generator.js';
import { supabase } from '../services/vault-client.js';

interface GenerateMocArgs {
  topic: string;
  regenerate?: boolean;
}

interface GenerateMocResult {
  success: boolean;
  path?: string;
  content?: string;
  learningCount?: number;
  message: string;
  error?: string;
}

/**
 * Generate MOC for a topic
 */
export async function generateMocTool(args: GenerateMocArgs): Promise<GenerateMocResult> {
  const { topic, regenerate = false } = args;

  if (!topic || typeof topic !== 'string') {
    return {
      success: false,
      message: 'Invalid topic parameter',
      error: 'Topic must be a non-empty string'
    };
  }

  const userId = '00000000-0000-0000-0000-000000000001'; // Single-user system
  const mocGenerator = new MOCGenerator(supabase, userId);

  try {
    // Check if MOC already exists
    const { data: existingMoc } = await supabase
      .from('files')
      .select('path')
      .eq('user_id', userId)
      .eq('path', `mocs/${topic}.md`)
      .maybeSingle();

    if (existingMoc && !regenerate) {
      return {
        success: false,
        path: existingMoc.path,
        message: `MOC already exists for "${topic}" at ${existingMoc.path}. Set regenerate=true to update it.`
      };
    }

    // Generate MOC
    const { path: mocPath, content, learningCount } = await mocGenerator.generateMOC(topic);

    // Return preview (first 500 chars)
    const preview = content.length > 500
      ? content.substring(0, 500) + '...'
      : content;

    return {
      success: true,
      path: mocPath,
      content: preview,
      learningCount,
      message: `MOC ${regenerate ? 'regenerated' : 'created'} for "${topic}" at ${mocPath} (${learningCount} learnings)`
    };

  } catch (error) {
    return {
      success: false,
      message: 'Failed to generate MOC',
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Tool definition for MCP registration
 */
export const generateMocToolDef = {
  name: 'generate_moc',
  description: 'Generate Map of Content (MOC) for a topic, linking all related learnings. MOCs are automatically created when topics reach 5+ learnings, but can be manually generated or regenerated.',
  inputSchema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description: 'Topic tag to generate MOC for (e.g., "sleep", "productivity")'
      },
      regenerate: {
        type: 'boolean',
        description: 'Regenerate if MOC already exists (default: false)'
      }
    },
    required: ['topic']
  }
};
