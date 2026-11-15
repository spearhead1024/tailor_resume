// Prompts the ChatGPT connection sends besides the CV prompt (that one comes from the
// server: GET /api/resumes/prompt). Plain functions — imported by the runner, and the
// driver receives the finished text.

// Words and phrases that make an answer read as AI-written. ChatGPT is told to avoid them,
// and cleanAnswer() softens what slips through.
const AI_TELLS = [
  'delve', 'leverage', 'leveraging', 'passionate', 'spearheaded', 'synergy', 'cutting-edge', 'robust', 'seamless', 'seamlessly',
  'dynamic', 'fast-paced', 'thrilled', 'excited to', 'furthermore', 'moreover', 'additionally', "in today's", 'ever-evolving',
  'landscape', 'tapestry', 'realm', 'navigate', 'navigating', 'foster', 'pivotal', 'honed', 'utilize', 'showcase', 'testament',
  'align with', 'resonate', 'eager', 'keen to', 'drive innovation', 'results-driven', 'proven track record', 'deep dive',
  'game-changer', 'unwavering', 'meticulous', 'holistic', 'paramount', 'embark', 'journey', 'elevate', 'empower',
];

/** The prompt that answers application questions in the thread that wrote the CV. */
export function answersPrompt(questions, { context = '' } = {}) {
  const list = questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
  return [
    context
      ? `Answer the job application questions below as the candidate described here.\n\n${context}`
      : 'Now answer the job application questions below as the candidate whose resume you just wrote, for this same job.',
    '',
    'How to write each answer:',
    '- 2 or 3 sentences, under 70 words.',
    '- First person, plain everyday English, the way an experienced engineer types into a form. Contractions are fine.',
    '- Be concrete: name a real project, technology, number or result from the resume. No generic claims.',
    '- Vary how sentences start and how long they are. Never open with "I am excited", "As a", "With X years" or "I have always".',
    `- Never use these words or phrases: ${AI_TELLS.join(', ')}.`,
    '- No em dashes, no bullet points, no headings, no markdown, no emojis, no quotes around the answer. Do not repeat the question.',
    '',
    `Return ONLY a JSON array of ${questions.length} string${questions.length === 1 ? '' : 's'} — one answer per question, in the same order — and nothing else.`,
    '',
    'QUESTIONS:',
    list,
  ].join('\n');
}

/** Tidy one answer: no wrapping quotes, no em dashes, single spaces. */
export function cleanAnswer(text) {
  return String(text || '')
    .replace(/^\s*["“”']+|["“”']+\s*$/g, '')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .replace(/ ,/g, ',')
    .trim();
}
