'use strict';

const fs = require('fs');

let logger;
try { logger = require('../utils/logger.cjs'); } catch (_) {
  logger = { info: () => {}, warn: () => {}, error: () => {} };
}

const SYSTEM_PROMPT = `You are a creative meeting analyst. Extract visual concepts, mood, and intent from meeting dialogue. Always respond in valid JSON.

When the input is in Norwegian (or any non-English language), translate all concepts, visual keywords, and image prompts to English. Keep the original transcript_segment as-is.

Respond with exactly this JSON structure:
{
  "timestamp": "ISO 8601 timestamp",
  "transcript_segment": "the original text",
  "concepts": ["concept1", "concept2"],
  "mood": "descriptive mood string",
  "visual_keywords": ["keyword1", "keyword2"],
  "color_palette_suggestion": ["#hex1", "#hex2", "#hex3"],
  "intent": "what the speaker wants to achieve",
  "action": "generate_moodboard_element|wait|refine_existing",
  "image_prompt_suggestion": "English prompt for image generation based on concepts",
  "confidence": 0.85
}`;

class ListenerAgent {
  constructor(opts = {}) {
    this.openaiKey = opts.openaiKey || process.env.OPENAI_API_KEY || null;
    this.anthropicKey = opts.anthropicKey || process.env.ANTHROPIC_API_KEY || null;
    this._useAnthropic = !!this.anthropicKey;

    // For concept extraction: prefer Anthropic if available, fall back to OpenAI
    this.model = this._useAnthropic
      ? (opts.claudeModel || 'claude-sonnet-4-20250514')
      : (opts.model || 'gpt-4o-mini');

    this.whisperModel = opts.whisperModel || 'whisper-1';
    this.language = opts.language || 'no';
  }

  _getConceptApiKey() {
    if (this._useAnthropic && this.anthropicKey) return this.anthropicKey;
    if (this.openaiKey) return this.openaiKey;
    throw new Error('No API key set — provide ANTHROPIC_API_KEY or OPENAI_API_KEY');
  }

  _getWhisperKey() {
    if (this.openaiKey) return this.openaiKey;
    throw new Error('OPENAI_API_KEY required for audio transcription (Whisper)');
  }

  /**
   * Extract structured concepts from a transcript segment.
   * @param {string} transcript - The transcript text
   * @param {string} [meetingContext] - Accumulated meeting context
   * @returns {Promise<object>} Concept bundle
   */
  async extractConcepts(transcript, meetingContext = '') {
    this._getConceptApiKey(); // validate early
    logger.info?.('listener', `Extracting concepts via ${this._useAnthropic ? 'Claude' : 'OpenAI'}`);

    let userPrompt = `Analyze this transcript segment and extract visual concepts:\n\n"${transcript}"`;
    if (meetingContext) {
      userPrompt += `\n\nMeeting context so far:\n${meetingContext}`;
    }

    let text;
    if (this._useAnthropic) {
      text = await this._callAnthropic(userPrompt);
    } else {
      text = await this._callOpenAI(userPrompt);
    }

    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
    const parsed = JSON.parse(jsonMatch[1].trim());

    if (!parsed.timestamp) parsed.timestamp = new Date().toISOString();
    if (!parsed.transcript_segment) parsed.transcript_segment = transcript;

    return parsed;
  }

  /**
   * Check if a concept bundle should trigger visual generation.
   */
  shouldGenerateVisual(conceptBundle) {
    if (!conceptBundle) return false;
    if (conceptBundle.confidence < 0.3) return false;
    if (conceptBundle.action === 'wait') return false;
    return true;
  }

  async _callAnthropic(userPrompt) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${errText}`);
    }
    const data = await res.json();
    return data.content?.[0]?.text || '{}';
  }

  async _callOpenAI(userPrompt) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.openaiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1024,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${errText}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '{}';
  }

  /** Transcribe audio via Whisper (always requires OpenAI key) */
  async transcribe(audioFilePath) {
    this._getWhisperKey(); // validate
    const { processAudioFile } = require('../data/audio-provider.cjs');
    const result = processAudioFile(audioFilePath, { language: this.language });
    return result.text;
  }

  async processAudio(audioFilePath) {
    const transcript = await this.transcribe(audioFilePath);
    const concepts = await this.extractConcepts(transcript);
    return { transcript, concepts };
  }

  async processText(text) {
    const concepts = await this.extractConcepts(text);
    return { transcript: text, concepts };
  }
}

module.exports = { ListenerAgent };
