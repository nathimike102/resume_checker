// Rules before model, part 1.
//
// ALIASES are the same thing under two names — "k8s" IS Kubernetes — so they
// score 1.0, exactly like a literal match.
//
// EQUIVALENCES are the cheap half of the semantic tier. If a resume says
// "WebSockets" and the JD asks for "event-driven systems", we don't need to
// pay for a model call to know that's real evidence. Anything not covered
// here still goes to the model. Every hit here is a model call we didn't make,
// counted as `rule_resolved` and shown in the stats.

export const ALIASES = [
  ['javascript', 'js', 'ecmascript'],
  ['typescript', 'ts'],
  ['node.js', 'node', 'nodejs'],
  ['react', 'react.js', 'reactjs'],
  ['vue', 'vue.js', 'vuejs'],
  ['angular', 'angular.js', 'angularjs'],
  ['kubernetes', 'k8s'],
  ['postgresql', 'postgres', 'psql'],
  ['mongodb', 'mongo'],
  ['golang', 'go'],
  ['python', 'python3'],
  ['ci/cd', 'cicd', 'ci cd', 'continuous integration', 'continuous delivery'],
  ['machine learning', 'ml'],
  ['deep learning', 'dl'],
  ['natural language processing', 'nlp'],
  ['amazon web services', 'aws'],
  ['google cloud platform', 'gcp', 'google cloud'],
  ['rest', 'rest api', 'restful', 'restful api'],
  ['object oriented programming', 'oop'],
  ['data structures and algorithms', 'dsa', 'data structures', 'algorithms'],
];

// { requirement patterns } <- { evidence patterns } => verdict
export const EQUIVALENCES = [
  { req: ['event driven', 'event-driven', 'event driven systems', 'real time systems'],
    evidence: ['websocket', 'socket.io', 'kafka', 'rabbitmq', 'pub/sub', 'message queue', 'real time chat', 'sse'],
    verdict: 'semantic' },
  { req: ['containers', 'containerization', 'containerisation'],
    evidence: ['docker', 'podman', 'kubernetes'], verdict: 'semantic' },
  { req: ['kubernetes'], evidence: ['docker', 'docker compose'], verdict: 'adjacent' },
  { req: ['ci/cd', 'devops', 'build pipelines'],
    evidence: ['github actions', 'jenkins', 'gitlab ci', 'circleci', 'travis'], verdict: 'semantic' },
  { req: ['rest', 'rest api', 'api development', 'backend api'],
    evidence: ['express', 'fastapi', 'flask', 'django', 'spring boot', 'gin'], verdict: 'semantic' },
  { req: ['sql', 'relational database', 'relational databases'],
    evidence: ['postgresql', 'mysql', 'sqlite', 'oracle', 'sql server'], verdict: 'semantic' },
  { req: ['nosql', 'document database'],
    evidence: ['mongodb', 'dynamodb', 'firestore', 'cassandra', 'redis'], verdict: 'semantic' },
  { req: ['cloud', 'cloud platforms', 'cloud deployment'],
    evidence: ['aws', 'gcp', 'azure', 'heroku', 'render', 'vercel', 'ec2', 's3'], verdict: 'semantic' },
  { req: ['machine learning'],
    evidence: ['scikit-learn', 'sklearn', 'pytorch', 'tensorflow', 'xgboost', 'regression model', 'classifier'],
    verdict: 'semantic' },
  { req: ['deep learning', 'neural networks'],
    evidence: ['pytorch', 'tensorflow', 'keras', 'cnn', 'rnn', 'transformer'], verdict: 'semantic' },
  { req: ['nlp', 'natural language processing'],
    evidence: ['transformers', 'bert', 'spacy', 'hugging face', 'huggingface', 'tokenization', 'embeddings'],
    verdict: 'semantic' },
  { req: ['llm', 'generative ai', 'genai'],
    evidence: ['openai api', 'anthropic', 'claude', 'gpt', 'langchain', 'rag', 'prompt engineering'],
    verdict: 'semantic' },
  { req: ['frontend', 'front end', 'ui development'],
    evidence: ['react', 'vue', 'angular', 'svelte', 'next.js', 'tailwind'], verdict: 'semantic' },
  { req: ['backend', 'back end', 'server side'],
    evidence: ['node.js', 'express', 'django', 'flask', 'spring', 'rails'], verdict: 'semantic' },
  { req: ['full stack', 'fullstack'],
    evidence: ['mern', 'mean', 'react', 'node.js'], verdict: 'semantic' },
  { req: ['typescript'], evidence: ['javascript'], verdict: 'adjacent' },
  { req: ['distributed systems'],
    evidence: ['microservices', 'kafka', 'raft', 'sharding', 'replication'], verdict: 'adjacent' },
  { req: ['microservices'],
    evidence: ['docker', 'kubernetes', 'service oriented', 'grpc'], verdict: 'adjacent' },
  { req: ['unit testing', 'testing', 'test automation'],
    evidence: ['jest', 'pytest', 'mocha', 'junit', 'vitest', 'cypress', 'tdd'], verdict: 'semantic' },
  { req: ['version control'], evidence: ['git', 'github', 'gitlab', 'bitbucket'], verdict: 'semantic' },
  { req: ['agile', 'scrum'], evidence: ['sprint', 'jira', 'stand-up', 'standup', 'kanban'], verdict: 'semantic' },
  { req: ['etl', 'data pipelines', 'data engineering'],
    evidence: ['airflow', 'spark', 'dbt', 'bigquery', 'kafka', 'batch job'], verdict: 'semantic' },
  { req: ['system design', 'scalability'],
    evidence: ['caching', 'redis', 'load balancer', 'horizontal scaling', 'rate limiting'], verdict: 'adjacent' },
  { req: ['linux', 'unix'], evidence: ['bash', 'shell scripting', 'ubuntu', 'debian'], verdict: 'semantic' },
  { req: ['mobile development'],
    evidence: ['react native', 'flutter', 'android', 'kotlin', 'swift'], verdict: 'semantic' },
  { req: ['security', 'application security'],
    evidence: ['owasp', 'xss', 'sql injection', 'penetration testing', 'jwt', 'oauth'], verdict: 'semantic' },
  { req: ['blockchain', 'web3'],
    evidence: ['solidity', 'ethereum', 'smart contract', 'hardhat'], verdict: 'semantic' },
  { req: ['data analysis', 'analytics'],
    evidence: ['pandas', 'numpy', 'tableau', 'power bi', 'sql queries', 'matplotlib'], verdict: 'semantic' },
];

const canonical = new Map();
for (const group of ALIASES) {
  for (const name of group) canonical.set(name, group[0]);
}

/** Maps "k8s" -> "kubernetes". Unknown names pass through unchanged. */
export function canonicalise(skill) {
  return canonical.get(skill) || skill;
}
