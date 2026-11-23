# India Tourism Collector - Initial CodeRabbit Review



## Review objective



Perform a rigorous review of the existing India Tourism Collector project.



The project collects tourism places across approximately 500 Indian cities using OpenStreetMap, Wikidata and Wikipedia. Supabase is the database and Cloudflare Workers is the backend.



## Areas to inspect



1. Data collection completeness and source reliability.

2. Duplicate detection across OSM, Wikidata and Wikipedia.

3. City radius filtering and coordinate accuracy.

4. Category normalization and multilingual names.

5. Description accuracy and source attribution.

6. Image licensing and attribution verification.

7. Supabase schema and database integrity.

8. API rate limits, retries and failure recovery.

9. Worker security and secret management.

10. Scalability and resumability for 500 cities.



## Review requirements



- Inspect the existing implementation, not just this documentation file.

- Identify confirmed bugs and security vulnerabilities.

- Distinguish critical defects from suggestions.

- Include affected file paths and code locations.

- Explain impact and recommend practical fixes.

- Avoid unnecessary rewrites.

- Do not modify application code automatically.

- Do not change database schemas or deploy anything.



