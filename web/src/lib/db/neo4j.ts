import "../env";
import neo4j, { type Driver } from "neo4j-driver";

/** Neo4j holds a read-only mirror of the sample and collaboration network (F2). */

const globalForNeo4j = globalThis as unknown as { neo4jDriver?: Driver };

export function getNeo4j(): Driver {
  if (!globalForNeo4j.neo4jDriver) {
    const { NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD } = process.env;
    if (!NEO4J_URI || !NEO4J_USER || !NEO4J_PASSWORD) throw new Error("NEO4J_URI/USER/PASSWORD are not set");
    globalForNeo4j.neo4jDriver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD), {
      disableLosslessIntegers: true, // return plain JS numbers; our ids are small
    });
  }
  return globalForNeo4j.neo4jDriver;
}

export async function closeNeo4j(): Promise<void> {
  await globalForNeo4j.neo4jDriver?.close();
  globalForNeo4j.neo4jDriver = undefined;
}
