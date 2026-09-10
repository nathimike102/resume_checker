// JSON Schemas handed to structured outputs, so the model is constrained at
// decode time instead of politely asked for JSON. validate() in schema.js
// still runs afterwards — a schema-valid document can still be nonsense.

const CONFIDENCE = ['high', 'medium', 'low'];

function requirementSchema() {
  return {
    type: 'object',
    properties: {
      skill: { type: 'string' },
      why: { type: 'string' },
      weight: { type: 'integer', minimum: 1, maximum: 5 },
    },
    required: ['skill', 'why', 'weight'],
    additionalProperties: false,
  };
}

export const RESUME_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    contact: {
      type: 'object',
      properties: {
        email: { type: 'string' },
        phone: { type: 'string' },
        links: { type: 'array', items: { type: 'string' } },
      },
      required: ['email', 'phone', 'links'],
      additionalProperties: false,
    },
    skills: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          evidence: { type: 'string' },
          strength: { type: 'string', enum: ['strong', 'mentioned'] },
        },
        required: ['name', 'evidence', 'strength'],
        additionalProperties: false,
      },
    },
    experience: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          org: { type: 'string' },
          duration_months: { type: 'integer' },
          highlights: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'org', 'duration_months', 'highlights'],
        additionalProperties: false,
      },
    },
    projects: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          tech: { type: 'array', items: { type: 'string' } },
          one_line: { type: 'string' },
        },
        required: ['name', 'tech', 'one_line'],
        additionalProperties: false,
      },
    },
    education: {
      type: 'object',
      properties: {
        degree: { type: 'string' },
        field: { type: 'string' },
        institution: { type: 'string' },
        graduation: { type: 'string' },
      },
      required: ['degree', 'field', 'institution', 'graduation'],
      additionalProperties: false,
    },
    total_experience_months: { type: 'integer' },
    _parse_confidence: { type: 'string', enum: CONFIDENCE },
  },
  required: ['name', 'contact', 'skills', 'experience', 'projects', 'education',
    'total_experience_months', '_parse_confidence'],
  additionalProperties: false,
};

export const JD_SCHEMA = {
  type: 'object',
  properties: {
    role_title: { type: 'string' },
    seniority: { type: 'string', enum: ['intern', 'junior', 'mid', 'senior'] },
    must_have: { type: 'array', items: requirementSchema() },
    nice_to_have: { type: 'array', items: requirementSchema() },
    responsibilities: { type: 'array', items: { type: 'string' } },
    domain: { type: 'string' },
    min_experience_months: { type: 'integer' },
    _parse_confidence: { type: 'string', enum: CONFIDENCE },
  },
  required: ['role_title', 'seniority', 'must_have', 'nice_to_have',
    'responsibilities', 'domain', 'min_experience_months', '_parse_confidence'],
  additionalProperties: false,
};

export const SEMANTIC_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          requirement: { type: 'string' },
          verdict: { type: 'string', enum: ['semantic', 'adjacent', 'absent'] },
          evidence: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['requirement', 'verdict', 'evidence', 'why'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdicts'],
  additionalProperties: false,
};

export const COURSES_SCHEMA = {
  type: 'object',
  properties: {
    picks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          gap: { type: 'string' },
          course_id: { type: 'string' },
          rationale: { type: 'string' },
        },
        required: ['gap', 'course_id', 'rationale'],
        additionalProperties: false,
      },
    },
  },
  required: ['picks'],
  additionalProperties: false,
};

export const IMPROVEMENTS_SCHEMA = {
  type: 'object',
  properties: {
    improvements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          target: { type: 'string' },
          issue: { type: 'string' },
          suggested_rewrite: { type: 'string' },
        },
        required: ['target', 'issue', 'suggested_rewrite'],
        additionalProperties: false,
      },
    },
  },
  required: ['improvements'],
  additionalProperties: false,
};
