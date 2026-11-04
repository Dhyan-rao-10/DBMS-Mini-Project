// Example queries for the Neo4j Browser (http://localhost:7474).
// The graph is a read-only mirror of Postgres, built by `npm run stores -- graph`
// (web/src/lib/stores/graph.ts). Model:
//   (:Contributor)-[:CREDITED_ON {role, share_pct, version_id}]->(:Track)
//   (:Track)-[:SAMPLES {upstream_pct}]->(:Track)          sampling -> sampled

// 1. The whole sample chain with everyone credited on it (good picture for the demo)
MATCH p = (:Track)-[:SAMPLES*1..]->(:Track)
UNWIND nodes(p) AS t
MATCH (c:Contributor)-[r:CREDITED_ON]->(t)
RETURN p, c, r;

// 2. Shortest connection between two people through shared tracks and samples
MATCH (a:Contributor {name: 'Tara'}), (b:Contributor {name: 'Leela Krishnan'}),
      p = shortestPath((a)-[:CREDITED_ON|SAMPLES*..10]-(b))
RETURN p;

// 3. Everything upstream of Rain Cypher, with hop count
//    (the same question as the WITH RECURSIVE query in docs/05 §5.2)
MATCH p = (:Track {title: 'Rain Cypher'})-[:SAMPLES*1..]->(t:Track)
RETURN t.title AS upstream_track, min(length(p)) AS hops
ORDER BY hops;

// 4. Most-sampled tracks, counting indirect samples
MATCH p = (d:Track)-[:SAMPLES*1..]->(t:Track)
RETURN t.title, count(DISTINCT d) AS sampled_by, max(length(p)) AS deepest_chain
ORDER BY sampled_by DESC;

// 5. A producer's most frequent collaborators
MATCH (me:Contributor {name: 'Kabir Beats'})-[:CREDITED_ON]->(t:Track)<-[:CREDITED_ON]-(other:Contributor)
RETURN other.name, count(DISTINCT t) AS shared_tracks, collect(DISTINCT t.title) AS tracks
ORDER BY shared_tracks DESC;

// 6. Who earns from Raag Megh, directly or through samples, and how far away they are
MATCH p = (t:Track)-[:SAMPLES*0..]->(:Track {title: 'Raag Megh (Revival)'})
MATCH (c:Contributor)-[:CREDITED_ON]->(t)
RETURN c.name, t.title, length(p) AS hops_from_raag_megh
ORDER BY hops_from_raag_megh, c.name;
