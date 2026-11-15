"""ATS score — a straight port of VPS1's analyze_ats_score (core/resume_engine.py).

Scores a generated résumé JSON against the job description, 0–99:
  Keyword Match      30  top-14 JD keywords found anywhere in the résumé text
  Title Alignment    15  target role in the headline / role titles
  Skills Alignment   15  technical skills that exactly match JD keywords
  Experience Evidence 20 bullets naming JD keywords and known tech
  Structure          15  headline, summary, skills, work history, education + summary length
  Fit Bonus          10  extra credit for high coverage / many exact matches
Well-matched résumés are floored at 90 (solid) or 93 (strong), as on VPS1.

The vocabulary below is VPS1's own (kept separate from core.resume_engine's
exporter list) so a résumé scores the same here as it would on VPS1.
"""
from __future__ import annotations

import re
from collections import Counter
from copy import deepcopy

KNOWN_TECH_TERMS = [
    'React', 'Next.js', 'Redux', 'React Query', 'Tailwind CSS', 'Material UI', 'Bootstrap', 'Storybook', 'Webpack', 'Vite',
    'Angular', 'Vue', 'Nuxt', 'Svelte', 'jQuery',
    'Node.js', 'Express', 'NestJS', 'FastAPI', 'Flask', 'Django', 'Spring Boot', 'ASP.NET Core', '.NET', 'Ruby on Rails',
    'Laravel', 'Phoenix', 'gRPC', 'GraphQL', 'Apollo GraphQL', 'Hibernate', 'Entity Framework', 'Prisma', 'SQLAlchemy',
    'RabbitMQ', 'Celery',
    'PostgreSQL', 'MySQL', 'SQL Server', 'SQLite', 'MongoDB', 'Redis', 'Elasticsearch', 'OpenSearch', 'Kafka', 'Snowflake',
    'dbt', 'Airflow', 'Spark', 'BigQuery', 'DynamoDB',
    'AWS', 'Azure', 'GCP', 'Docker', 'Kubernetes', 'Helm', 'Terraform', 'GitHub Actions', 'GitLab CI', 'Jenkins', 'Argo CD',
    'Prometheus', 'Grafana', 'Datadog', 'Sentry', 'Nginx', 'Linux', 'Azure DevOps', 'Cloud Run', 'GKE', 'EKS', 'ECS', 'EC2',
    'S3', 'RDS', 'Lambda', 'CloudFront', 'IAM', 'Key Vault', 'Azure Functions',
    'Jest', 'Playwright', 'Cypress', 'React Testing Library', 'Pytest', 'JUnit', 'NUnit', 'Selenium', 'Postman',
    'OpenAI API', 'LangChain', 'LlamaIndex', 'Pinecone', 'Weaviate', 'PyTorch', 'TensorFlow', 'Hugging Face',
    'Stripe', 'Twilio', 'Socket.IO', 'Auth0', 'Okta', 'Splunk', 'New Relic', 'MCP', 'FastMCP'
]

TECH_ALIAS_MAP = {
    'reactjs': 'React', 'react.js': 'React', 'react': 'React',
    'next': 'Next.js', 'nextjs': 'Next.js', 'next.js': 'Next.js',
    'redux toolkit': 'Redux', 'redux': 'Redux',
    'react-query': 'React Query', 'tanstack query': 'React Query', 'react query': 'React Query',
    'tailwind': 'Tailwind CSS', 'tailwindcss': 'Tailwind CSS',
    'mui': 'Material UI', 'material-ui': 'Material UI', 'material ui': 'Material UI',
    'angularjs': 'Angular', 'angular': 'Angular', 'vue.js': 'Vue', 'vuejs': 'Vue', 'vue': 'Vue', 'nuxt.js': 'Nuxt', 'nuxt': 'Nuxt',
    'node': 'Node.js', 'nodejs': 'Node.js', 'node.js': 'Node.js',
    'express.js': 'Express', 'express': 'Express', 'nestjs': 'NestJS', 'nest.js': 'NestJS', 'nest': 'NestJS',
    'fast api': 'FastAPI', 'fastapi': 'FastAPI', 'flask': 'Flask', 'django': 'Django',
    'spring': 'Spring Boot', 'springboot': 'Spring Boot', 'spring boot': 'Spring Boot',
    'asp.net': 'ASP.NET Core', 'asp.net core': 'ASP.NET Core', 'dotnet': '.NET', '.net': '.NET',
    'rails': 'Ruby on Rails', 'ruby on rails': 'Ruby on Rails', 'laravel': 'Laravel', 'phoenix': 'Phoenix',
    'graphql': 'GraphQL', 'apollo': 'Apollo GraphQL', 'apollo graphql': 'Apollo GraphQL', 'grpc': 'gRPC',
    'entity framework': 'Entity Framework', 'hibernate': 'Hibernate', 'prisma': 'Prisma', 'sqlalchemy': 'SQLAlchemy',
    'rabbitmq': 'RabbitMQ', 'celery': 'Celery',
    'postgres': 'PostgreSQL', 'postgresql': 'PostgreSQL', 'mysql': 'MySQL', 'sql server': 'SQL Server', 'sqlite': 'SQLite',
    'mongodb': 'MongoDB', 'mongo': 'MongoDB', 'redis': 'Redis', 'elasticsearch': 'Elasticsearch', 'opensearch': 'OpenSearch',
    'kafka': 'Kafka', 'snowflake': 'Snowflake', 'dbt': 'dbt', 'airflow': 'Airflow', 'spark': 'Spark', 'bigquery': 'BigQuery',
    'dynamodb': 'DynamoDB',
    'aws': 'AWS', 'amazon web services': 'AWS', 'azure': 'Azure', 'gcp': 'GCP', 'google cloud': 'GCP',
    'docker': 'Docker', 'k8s': 'Kubernetes', 'kubernetes': 'Kubernetes', 'helm': 'Helm', 'terraform': 'Terraform',
    'github actions': 'GitHub Actions', 'gitlab ci': 'GitLab CI', 'jenkins': 'Jenkins', 'argocd': 'Argo CD', 'argo cd': 'Argo CD',
    'prometheus': 'Prometheus', 'grafana': 'Grafana', 'datadog': 'Datadog', 'sentry': 'Sentry', 'nginx': 'Nginx', 'linux': 'Linux',
    'azure devops': 'Azure DevOps', 'cloud run': 'Cloud Run', 'gke': 'GKE', 'eks': 'EKS', 'ecs': 'ECS', 'ec2': 'EC2', 's3': 'S3',
    'rds': 'RDS', 'lambda': 'Lambda', 'cloudfront': 'CloudFront', 'iam': 'IAM', 'key vault': 'Key Vault', 'azure functions': 'Azure Functions',
    'jest': 'Jest', 'playwright': 'Playwright', 'cypress': 'Cypress', 'react testing library': 'React Testing Library',
    'pytest': 'Pytest', 'junit': 'JUnit', 'nunit': 'NUnit', 'selenium': 'Selenium', 'postman': 'Postman',
    'openai': 'OpenAI API', 'openai api': 'OpenAI API', 'langchain': 'LangChain', 'llamaindex': 'LlamaIndex',
    'pinecone': 'Pinecone', 'weaviate': 'Weaviate', 'pytorch': 'PyTorch', 'tensorflow': 'TensorFlow', 'huggingface': 'Hugging Face',
    'hugging face': 'Hugging Face',
    'stripe': 'Stripe', 'twilio': 'Twilio', 'socket.io': 'Socket.IO', 'auth0': 'Auth0', 'okta': 'Okta', 'splunk': 'Splunk',
    'new relic': 'New Relic', 'mcp': 'MCP', 'fastmcp': 'FastMCP'
}

TECH_EXPANSION_MAP = {
    'React': ['Next.js', 'Redux', 'React Query', 'Tailwind CSS', 'Material UI', 'Storybook', 'Jest', 'Playwright', 'React Testing Library', 'Vite'],
    'Angular': ['TypeScript', 'RxJS', 'NgRx', 'Jest', 'Cypress'],
    'Vue': ['Nuxt', 'Pinia', 'Vite', 'Jest', 'Cypress'],
    'Node.js': ['Express', 'NestJS', 'GraphQL', 'Apollo GraphQL', 'PostgreSQL', 'Redis', 'Docker', 'Jest'],
    'Express': ['Node.js', 'PostgreSQL', 'Redis', 'Docker', 'Jest', 'Postman'],
    'NestJS': ['Node.js', 'PostgreSQL', 'Redis', 'Docker', 'Jest', 'Postman'],
    'FastAPI': ['Python', 'PostgreSQL', 'Redis', 'Docker', 'Pytest', 'Postman'],
    'Django': ['PostgreSQL', 'Redis', 'Docker', 'Pytest'],
    'Flask': ['PostgreSQL', 'Redis', 'Docker', 'Pytest'],
    'Spring Boot': ['Java', 'PostgreSQL', 'Kafka', 'Docker', 'Kubernetes', 'JUnit', 'Hibernate'],
    'ASP.NET Core': ['.NET', 'SQL Server', 'Azure', 'Docker', 'NUnit', 'Entity Framework'],
    'GraphQL': ['Apollo GraphQL', 'PostgreSQL', 'Redis', 'Node.js'],
    'Kafka': ['Spark', 'Docker', 'Kubernetes', 'Prometheus', 'Grafana'],
    'AWS': ['EC2', 'S3', 'Lambda', 'RDS', 'EKS', 'ECS', 'CloudFront', 'IAM', 'Terraform', 'GitHub Actions'],
    'Azure': ['Azure DevOps', 'Azure Functions', 'Key Vault', '.NET', 'Terraform', 'Docker'],
    'GCP': ['Cloud Run', 'GKE', 'BigQuery', 'Terraform', 'Docker'],
    'Docker': ['Kubernetes', 'Helm', 'Terraform', 'GitHub Actions', 'GitLab CI', 'Jenkins'],
    'Kubernetes': ['Helm', 'Terraform', 'Prometheus', 'Grafana', 'Argo CD'],
    'OpenAI API': ['LangChain', 'LlamaIndex', 'Pinecone', 'Weaviate', 'PyTorch', 'Hugging Face'],
    'PyTorch': ['TensorFlow', 'Hugging Face', 'OpenAI API'],
    'PostgreSQL': ['Redis', 'Elasticsearch', 'Kafka', 'Docker'],
    'Snowflake': ['dbt', 'Airflow', 'Spark', 'BigQuery'],
}

ROLE_TECH_STACKS = {
    'Frontend Engineer': ['React', 'Next.js', 'Redux', 'React Query', 'Tailwind CSS', 'Material UI', 'Storybook', 'Vite', 'Webpack', 'Jest', 'Playwright', 'Cypress', 'React Testing Library'],
    'Backend Engineer': ['Node.js', 'Express', 'NestJS', 'FastAPI', 'Django', 'Spring Boot', 'ASP.NET Core', 'GraphQL', 'Apollo GraphQL', 'gRPC', 'PostgreSQL', 'MySQL', 'Redis', 'Kafka', 'Docker', 'Kubernetes', 'Terraform', 'GitHub Actions', 'Datadog', 'Sentry'],
    'Full Stack Engineer': ['React', 'Next.js', 'Tailwind CSS', 'Material UI', 'Node.js', 'Express', 'NestJS', 'FastAPI', 'GraphQL', 'Apollo GraphQL', 'PostgreSQL', 'Redis', 'Docker', 'Kubernetes', 'AWS', 'GitHub Actions', 'Jest', 'Playwright'],
    'Data Engineer': ['Airflow', 'dbt', 'Spark', 'Kafka', 'Snowflake', 'BigQuery', 'PostgreSQL', 'MySQL', 'Redis', 'Docker', 'Kubernetes', 'Terraform', 'AWS', 'GCP', 'Datadog'],
    'DevOps Engineer': ['AWS', 'Azure', 'GCP', 'Docker', 'Kubernetes', 'Helm', 'Terraform', 'GitHub Actions', 'GitLab CI', 'Jenkins', 'Argo CD', 'Prometheus', 'Grafana', 'Datadog', 'Sentry', 'Linux', 'Nginx'],
    'Machine Learning Engineer': ['OpenAI API', 'LangChain', 'LlamaIndex', 'Pinecone', 'Weaviate', 'PyTorch', 'TensorFlow', 'Hugging Face', 'Airflow', 'Spark', 'Docker', 'Kubernetes', 'AWS', 'GCP', 'PostgreSQL'],
    'MLOps Engineer': ['OpenAI API', 'LangChain', 'Pinecone', 'Weaviate', 'PyTorch', 'TensorFlow', 'Docker', 'Kubernetes', 'Terraform', 'GitHub Actions', 'Prometheus', 'Grafana', 'AWS', 'GCP'],
    'Platform Engineer': ['Docker', 'Kubernetes', 'Helm', 'Terraform', 'GitHub Actions', 'GitLab CI', 'Jenkins', 'Argo CD', 'Prometheus', 'Grafana', 'Datadog', 'AWS', 'Azure', 'GCP', 'Linux'],
    'Site Reliability Engineer': ['AWS', 'Azure', 'GCP', 'Docker', 'Kubernetes', 'Terraform', 'Prometheus', 'Grafana', 'Datadog', 'Sentry', 'Nginx', 'Linux', 'Argo CD'],
}

ROLE_HINTS = [
    ('Machine Learning Engineer', ['machine learning', 'ml', 'pytorch', 'tensorflow', 'llm', 'nlp', 'rag', 'model training', 'inference', 'fine-tuning']),
    ('MLOps Engineer', ['mlops', 'model deployment', 'ml pipeline', 'inference', 'feature store']),
    ('DevOps Engineer', ['devops', 'terraform', 'kubernetes', 'helm', 'docker', 'ci/cd', 'jenkins', 'github actions', 'observability', 'infrastructure']),
    ('Site Reliability Engineer', ['sre', 'reliability', 'incident', 'observability', 'monitoring', 'availability']),
    ('Data Engineer', ['data engineer', 'etl', 'elt', 'airflow', 'spark', 'warehouse', 'snowflake', 'dbt', 'pipeline']),
    ('Backend Engineer', ['backend', 'api', 'microservices', 'spring boot', 'java', 'fastapi', 'node.js', 'distributed systems']),
    ('Frontend Engineer', ['frontend', 'react', 'typescript', 'vue', 'angular', 'ui', 'web accessibility']),
    ('Platform Engineer', ['platform', 'developer tooling', 'kubernetes', 'terraform', 'internal tools']),
    ('Full Stack Engineer', ['full stack', 'react', 'node.js', 'typescript', 'python', 'api', 'frontend', 'backend']),
]

def _dedupe_preserve_order(items: list[str]) -> list[str]:
    ordered: list[str] = []
    seen: set[str] = set()
    for item in items or []:
        clean = str(item).strip()
        if not clean:
            continue
        canonical = _canonical_term(clean)
        key = canonical.lower()
        if key not in seen:
            seen.add(key)
            ordered.append(canonical)
    return ordered

def _canonical_term(value: str) -> str:
    clean = ' '.join(str(value).split()).strip()
    if not clean:
        return ''
    return TECH_ALIAS_MAP.get(clean.lower(), clean)

def _is_technical_stack_item(value: str) -> bool:
    canonical = _canonical_term(value)
    return canonical in KNOWN_TECH_TERMS

def _infer_target_title(target_role: str, keywords: list[str], profile_skills: list[str]) -> str:
    if str(target_role).strip():
        return ' '.join(str(target_role).split())
    blob = ' '.join([*keywords, *profile_skills]).lower()
    best_title = 'Software Engineer'
    best_score = -1
    for title, hints in ROLE_HINTS:
        score = sum(2 if hint in blob else 0 for hint in hints)
        if title.lower() in blob:
            score += 3
        if score > best_score:
            best_score = score
            best_title = title
    return best_title

def _mentions(term: str, lowered: str) -> bool:
    """Whole-word mention (VPS1 used a raw substring test, so "next steps" counted as Next.js,
    "honest" as NestJS, "weeks" as EKS — inflating "missing keywords" and lowering the score)."""
    return re.search(rf"(?<![a-z0-9]){re.escape(term)}(?![a-z0-9])", lowered) is not None


# Tool names that are also everyday English words. As an ALIAS ("next", "nest", "spring") they are
# ignored — the specific form ("Next.js", "NestJS", "Spring Boot") still matches; as a canonical name
# ("Express", "Spark") they must appear Capitalized, so "express interest" isn't Express.js.
_ENGLISH_WORDS = {"next", "nest", "express", "spring", "phoenix", "apollo", "spark", "lambda", "helm"}


def _extract_explicit_jd_techs(job_description: str) -> list[str]:
    text = job_description or ''
    lowered = text.lower()
    found: list[str] = []
    for alias, canonical in TECH_ALIAS_MAP.items():
        if alias in _ENGLISH_WORDS:
            continue
        if _mentions(alias, lowered) and canonical not in found:
            found.append(canonical)
    for tech in KNOWN_TECH_TERMS:
        if tech.lower() in _ENGLISH_WORDS:
            hit = re.search(rf"(?<![A-Za-z0-9]){re.escape(tech)}(?![A-Za-z0-9])", text) is not None
        else:
            hit = _mentions(tech.lower(), lowered)
        if hit and tech not in found:
            found.append(tech)
    return found

def _role_stack_family(target_role: str, job_description: str) -> str:
    return _infer_target_title(target_role, _extract_explicit_jd_techs(job_description), [])

def _ensure_tech_range(existing: list[str], required_stack: list[str], minimum: int = 40, maximum: int = 50) -> list[str]:
    combined = [skill for skill in _dedupe_preserve_order(existing + required_stack) if _is_technical_stack_item(skill)]
    if len(combined) < minimum:
        for family in ROLE_TECH_STACKS.values():
            for tech in family:
                if tech not in combined and _is_technical_stack_item(tech):
                    combined.append(tech)
                if len(combined) >= minimum:
                    break
            if len(combined) >= minimum:
                break
    return combined[:maximum]

def _extract_raw_jd_terms(job_description: str) -> list[str]:
    text = job_description or ''
    raw_candidates = re.findall(r'[A-Za-z][A-Za-z0-9+.#/-]{2,}', text)
    stop_words = {
        'the', 'and', 'with', 'for', 'this', 'that', 'will', 'have', 'your', 'from', 'into', 'about', 'years', 'experience', 'team',
        'build', 'building', 'role', 'work', 'using', 'developer', 'engineer', 'software', 'strong', 'plus', 'across', 'are', 'must',
        'you', 'our', 'web', 'full', 'stack', 'features', 'ability', 'required', 'preferred', 'nice', 'looking', 'seeking', 'position',
        'candidate', 'need', 'needs', 'including', 'responsible', 'responsibilities', 'opportunity', 'environment'
    }
    ordered: list[str] = []
    for token in raw_candidates:
        clean = token.strip('.,:;()[]{}')
        canonical = _canonical_term(clean)
        if clean.lower() in stop_words:
            continue
        if canonical not in ordered:
            ordered.append(canonical)
    return ordered[:30]

def _expand_related_techs(seed_techs: list[str], role_family: str, keywords: list[str], minimum: int = 40, maximum: int = 50, second_pass: bool = False) -> list[str]:
    ordered = [tech for tech in _dedupe_preserve_order(seed_techs) if _is_technical_stack_item(tech)]

    for tech in list(ordered):
        for related in TECH_EXPANSION_MAP.get(tech, []):
            if related not in ordered and _is_technical_stack_item(related):
                ordered.append(related)

    for keyword in keywords:
        canonical = _canonical_term(keyword)
        if canonical in TECH_EXPANSION_MAP:
            for related in TECH_EXPANSION_MAP.get(canonical, []):
                if related not in ordered and _is_technical_stack_item(related):
                    ordered.append(related)

    for tech in ROLE_TECH_STACKS.get(role_family, []):
        if tech not in ordered and _is_technical_stack_item(tech):
            ordered.append(tech)
        if len(ordered) >= minimum:
            break

    if second_pass or len(ordered) < minimum:
        for family_name, family_stack in ROLE_TECH_STACKS.items():
            if family_name == role_family:
                continue
            for tech in family_stack:
                if tech not in ordered and _is_technical_stack_item(tech):
                    ordered.append(tech)
                if len(ordered) >= minimum:
                    break
            if len(ordered) >= minimum:
                break

    for tech in KNOWN_TECH_TERMS:
        if tech not in ordered:
            ordered.append(tech)
        if len(ordered) >= minimum:
            break

    return ordered[:maximum]

def _analyze_job_tech_stack(job_description: str, target_role: str = '') -> dict:
    explicit_techs = _extract_explicit_jd_techs(job_description)
    keywords = _dedupe_preserve_order(explicit_techs + _extract_raw_jd_terms(job_description))
    role_family = _role_stack_family(target_role, job_description)
    expanded_techs = _expand_related_techs(explicit_techs, role_family, keywords, minimum=40, maximum=50)
    if len(expanded_techs) < 40:
        expanded_techs = _expand_related_techs(expanded_techs + explicit_techs, role_family, keywords, minimum=40, maximum=50, second_pass=True)
    expanded_techs = _ensure_tech_range(expanded_techs, ROLE_TECH_STACKS.get(role_family, []), minimum=40, maximum=50)
    return {
        'explicit_techs': explicit_techs,
        'expanded_techs': expanded_techs,
        'keywords': keywords,
        'role_family': role_family,
    }

def _extract_keywords(job_description: str) -> list[str]:
    analysis = _analyze_job_tech_stack(job_description, target_role='')
    base = analysis.get('explicit_techs', []) + analysis.get('expanded_techs', [])[:18]

    text = job_description or ''
    raw_candidates = re.findall(r'[A-Za-z][A-Za-z0-9+.#/-]{2,}', text)
    stop_words = {
        'the', 'and', 'with', 'for', 'this', 'that', 'will', 'have', 'your', 'from', 'into', 'about', 'years',
        'experience', 'team', 'build', 'building', 'role', 'work', 'using', 'developer', 'engineer', 'software',
        'strong', 'plus', 'across', 'are', 'must', 'you', 'our', 'web', 'full', 'stack', 'features', 'ability',
        'required', 'preferred', 'nice', 'looking', 'seeking', 'position', 'candidate', 'need', 'needs', 'including', 'responsible', 'responsibilities', 'opportunity', 'environment'
    }
    counts: Counter[str] = Counter()
    for token in raw_candidates:
        clean = token.strip('.,:;()[]{}')
        if clean.lower() in stop_words:
            continue
        counts[clean] += 1

    keywords = _dedupe_preserve_order(base)
    for token, _ in counts.most_common(20):
        canonical = _canonical_term(token)
        if canonical not in keywords:
            keywords.append(canonical)
    return keywords[:24]

def analyze_ats_score(resume: dict, job_description: str, target_role: str = '') -> dict:
    resume = deepcopy(resume or {})
    job_description = job_description or ''
    keywords = _extract_keywords(job_description)
    if target_role:
        keywords = _dedupe_preserve_order([target_role, *keywords])

    headline = str(resume.get('headline', '')).strip()
    summary = str(resume.get('summary', '')).strip()
    technical_skills = [str(item).strip() for item in resume.get('technical_skills', []) if str(item).strip()]
    fit_keywords = [str(item).strip() for item in resume.get('fit_keywords', []) if str(item).strip()]
    work_history = resume.get('work_history', []) or []
    education_history = resume.get('education_history', []) or []

    resume_text_parts = [headline, summary]
    resume_text_parts.extend(technical_skills)
    resume_text_parts.extend(fit_keywords)
    for group in resume.get('skill_groups', []) or []:
        resume_text_parts.append(group.get('category', ''))
        resume_text_parts.extend(group.get('items', []))
    for job in work_history:
        resume_text_parts.extend([
            job.get('company_name', ''),
            job.get('role_title', ''),
            job.get('role_headline', ''),
            *job.get('bullets', []),
        ])
    resume_blob = ' '.join(str(part) for part in resume_text_parts if str(part).strip())
    resume_blob_lower = resume_blob.lower()

    top_keywords = keywords[:14]
    matched_keywords = [kw for kw in top_keywords if kw and kw.lower() in resume_blob_lower]
    missing_keywords = [kw for kw in top_keywords if kw and kw.lower() not in resume_blob_lower]
    coverage_ratio = len(matched_keywords) / max(len(top_keywords), 1)
    keyword_score = round(30 * coverage_ratio)

    inferred_title = _infer_target_title(target_role, keywords, technical_skills)
    title_alignment = 0
    headline_lower = headline.lower()
    if inferred_title and inferred_title.lower() in headline_lower:
        title_alignment += 10
    elif inferred_title and any(part.lower() in headline_lower for part in inferred_title.split() if len(part) > 3):
        title_alignment += 7
    if any(kw.lower() in headline_lower for kw in matched_keywords[:4]):
        title_alignment += 5
    if work_history and inferred_title and any(inferred_title.lower() in str(job.get('role_title', '')).lower() for job in work_history):
        title_alignment += 3
    title_alignment = min(title_alignment, 15)

    exact_skill_matches = [skill for skill in technical_skills if any(skill.lower() == kw.lower() for kw in keywords)]
    grouped_skill_matches = [kw for kw in matched_keywords if any(kw.lower() == str(item).lower() for group in resume.get('skill_groups', []) or [] for item in group.get('items', []))]
    skill_score = min(15, 6 + len(_dedupe_preserve_order(exact_skill_matches + grouped_skill_matches))) if (technical_skills or resume.get('skill_groups')) else 0

    bullets = [bullet for job in work_history for bullet in job.get('bullets', []) if str(bullet).strip()]
    experience_hits = sum(1 for bullet in bullets if any(kw.lower() in bullet.lower() for kw in top_keywords))
    tech_named_hits = sum(1 for bullet in bullets if any(term.lower() in bullet.lower() for term in KNOWN_TECH_TERMS))
    bullet_depth_bonus = 3 if len(bullets) >= max(4, len(work_history) * 3) else 0
    experience_score = 0
    if bullets:
        experience_score = min(20, 8 + min(experience_hits, 8) + min(tech_named_hits, 4) + bullet_depth_bonus)

    format_score = 0
    if headline:
        format_score += 2
    if summary:
        format_score += 2
    if technical_skills or resume.get('skill_groups'):
        format_score += 2
    if work_history:
        format_score += 3
    if education_history:
        format_score += 1

    summary_score = 0
    summary_len = len(summary)
    if 180 <= summary_len <= 650:
        summary_score = 5
    elif summary_len > 0:
        summary_score = 3

    fit_bonus = 0
    if coverage_ratio >= 0.55:
        fit_bonus += 6
    elif coverage_ratio >= 0.4:
        fit_bonus += 3
    if len(exact_skill_matches) >= 4:
        fit_bonus += 3
    elif len(exact_skill_matches) >= 2:
        fit_bonus += 1
    if experience_hits >= max(4, len(work_history) * 2):
        fit_bonus += 3
    elif experience_hits >= max(2, len(work_history)):
        fit_bonus += 1
    fit_bonus = min(fit_bonus, 10)

    overall = max(0, min(99, keyword_score + title_alignment + skill_score + experience_score + format_score + summary_score + fit_bonus))

    # Coverage is measured against the JD's explicit AND analyzer-expanded tech set;
    # an externally-generated resume can't mirror the analyzer's expansion, so the raw
    # keyword score under-rates genuinely on-target resumes. Education is preserved from
    # the uploaded DOCX (the pasted JSON's education_history is empty by design), so it
    # must NOT be required here. Floor genuinely well-matched resumes above the download
    # gate while leaving off-target resumes on their lower raw score.
    has_core = bool(headline) and bool(summary) and bool(work_history)
    strong_match = has_core and coverage_ratio >= 0.5 and len(exact_skill_matches) >= 3 and experience_hits >= max(4, len(work_history) * 2)
    solid_match = has_core and coverage_ratio >= 0.4 and len(exact_skill_matches) >= 2 and experience_hits >= max(3, len(work_history))
    if strong_match:
        overall = max(overall, 93)
    elif solid_match:
        overall = max(overall, 90)

    strengths: list[str] = []
    if matched_keywords:
        strengths.append(f'Matches {len(matched_keywords)} of the top {len(top_keywords)} job keywords, including {", ".join(matched_keywords[:5])}.')
    if headline:
        strengths.append(f'Headline is tailored toward {headline}.')
    if bullets:
        strengths.append(f'Work history contains {len(bullets)} bullets with concrete role evidence and named stack coverage.')
    if technical_skills or resume.get('skill_groups'):
        strengths.append(f'Technical skills section names relevant stacks directly, including {", ".join((technical_skills or fit_keywords)[:6])}.')

    risks: list[str] = []
    if missing_keywords:
        risks.append(f'Missing or underused JD terms: {", ".join(missing_keywords[:8])}.')
    if not bullets:
        risks.append('Work history needs bullets with concrete responsibilities and technologies.')
    elif experience_hits < max(3, len(work_history)):
        risks.append('Several bullets are still light on exact job-description technologies or domain terms.')
    if summary_len < 180:
        risks.append('Summary is short and may not surface enough positioning or tech focus.')
    if not exact_skill_matches:
        risks.append('Skills section does not show many exact keyword matches from the job description.')

    suggestions: list[str] = []
    if missing_keywords:
        suggestions.append(f'Add supported missing keywords into skills or bullets where truthful: {", ".join(missing_keywords[:6])}.')
    suggestions.append('Keep headline, summary, and first two bullets aligned to the same core role focus.')
    suggestions.append('Prefer exact stack names in bullets instead of broad phrases like backend services or cloud systems.')
    suggestions.append('Use role headlines and bullet openings to mirror the strongest JD themes.')

    category_scores = {
        'Keyword Match': keyword_score,
        'Title Alignment': title_alignment,
        'Skills Alignment': skill_score,
        'Experience Evidence': experience_score,
        'Structure': format_score + summary_score,
        'Fit Bonus': fit_bonus,
    }

    return {
        'overall_score': overall,
        'inferred_target_title': inferred_title,
        'matched_keywords': matched_keywords,
        'missing_keywords': missing_keywords,
        'category_scores': category_scores,
        'strengths': strengths[:4],
        'risks': risks[:4],
        'suggestions': suggestions[:4],
    }
