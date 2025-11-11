'use server';

/**
 * @fileOverview Executes a code snippet against multiple test cases and returns the results.
 *
 * - executeCode - A function that runs code against test cases in a sandbox.
 */

import {ai} from '@/ai/genkit';
import { ExecuteCodeInputSchema, ExecuteCodeOutputSchema, type ExecuteCodeInput, type ExecuteCodeOutput } from '@/types';


const PISTON_API_URL = 'https://emkc.org/api/v2/piston/execute';

// Language mapping from app values to Piston API aliases
const languageMap = {
    javascript: 'javascript',
    python: 'python',
    java: 'java',
    cpp: 'c++', // The Piston API expects 'c++' for C++
};

// Helper function to introduce a delay
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function executeCode(input: ExecuteCodeInput): Promise<ExecuteCodeOutput> {
  return executeCodeFlow(input);
}


const executeCodeFlow = ai.defineFlow(
  {
    name: 'executeCodeFlow',
    inputSchema: ExecuteCodeInputSchema,
    outputSchema: ExecuteCodeOutputSchema,
  },
  async (input) => {
    const results = [];
    let totalPassed = 0;

    // Map the incoming language to the one Piston API expects
    const executionLanguage = languageMap[input.language as keyof typeof languageMap] || input.language;

    for (const testCase of input.testCases) {
      try {
        const response = await fetch(PISTON_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            language: executionLanguage,
            version: '*',
            files: [{ content: input.sourceCode }],
            stdin: testCase.input,
          }),
        });
        
        if (!response.ok) {
           const errorBody = await response.text();
           const errorMessage = `API Error: ${response.statusText}${errorBody ? ` - ${errorBody}` : ''}`;
           results.push({
            input: testCase.input,
            expectedOutput: testCase.expectedOutput,
            actualOutput: errorMessage,
            isCorrect: false,
            error: errorMessage
          });
          continue;
        }

        const result = await response.json();
        const actualOutput = (result.run.output || '').trim();
        const isCorrect = actualOutput === testCase.expectedOutput.trim();

        if (isCorrect) {
          totalPassed++;
        }
        
        results.push({
          input: testCase.input,
          expectedOutput: testCase.expectedOutput,
          actualOutput: actualOutput,
          isCorrect: isCorrect,
          error: result.run.stderr || undefined,
        });

      } catch (error: any) {
        results.push({
          input: testCase.input,
          expectedOutput: testCase.expectedOutput,
          actualOutput: 'Execution Failed',
          isCorrect: false,
          error: error.message || 'An unknown error occurred.',
        });
      }
      // Add a delay to avoid rate-limiting
      await delay(500); 
    }
    
    return {
      results,
      totalPassed,
      totalCases: input.testCases.length,
    };
  }
);