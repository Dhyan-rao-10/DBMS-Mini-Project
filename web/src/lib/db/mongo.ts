import "../env";
import { MongoClient, type Db } from "mongodb";

/** MongoDB holds raw platform reports exactly as received (docs/05-nosql-vector-models.md §5.1). */

const globalForMongo = globalThis as unknown as { mongoClient?: MongoClient };

function getClient(): MongoClient {
  if (!globalForMongo.mongoClient) {
    if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not set");
    globalForMongo.mongoClient = new MongoClient(process.env.MONGODB_URI);
  }
  return globalForMongo.mongoClient;
}

export async function getMongoDb(): Promise<Db> {
  const client = getClient();
  await client.connect(); // no-op when already connected
  return client.db(process.env.MONGO_DB ?? "royalty_raw");
}

export const PLATFORMS = ["SPOTIFY", "YT_MUSIC", "JIOSAAVN", "APPLE_MUSIC", "GAANA"] as const;

/**
 * Creates the collections with JSON-schema validators and indexes.
 * `raw` is deliberately left schemaless: every platform sends a different shape.
 */
export async function ensureMongoCollections(): Promise<void> {
  const db = await getMongoDb();
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));

  const reportsValidator = {
    $jsonSchema: {
      bsonType: "object",
      required: ["platform", "period_start", "file_name", "uploaded_by", "uploaded_at", "status", "line_count"],
      properties: {
        platform: { enum: [...PLATFORMS] },
        period_start: { bsonType: "date" },
        file_name: { bsonType: "string" },
        uploaded_by: { bsonType: "int" },
        uploaded_at: { bsonType: "date" },
        status: { enum: ["uploaded", "loaded", "failed"] },
        line_count: { bsonType: "int", minimum: 0 },
        declared_totals: {
          bsonType: ["object", "null"],
          properties: { streams: { bsonType: ["long", "int"] }, revenue: { bsonType: "decimal" } },
        },
      },
    },
  };
  const linesValidator = {
    $jsonSchema: {
      bsonType: "object",
      required: ["report_id", "platform", "line_no", "raw"],
      properties: {
        report_id: { bsonType: "objectId" },
        platform: { enum: [...PLATFORMS] },
        line_no: { bsonType: "int", minimum: 1 },
        raw: { bsonType: "object" },
      },
    },
  };

  for (const [name, validator] of [
    ["reports", reportsValidator],
    ["report_lines", linesValidator],
  ] as const) {
    if (existing.has(name)) {
      await db.command({ collMod: name, validator, validationLevel: "strict" });
    } else {
      await db.createCollection(name, { validator, validationLevel: "strict" });
    }
  }

  await db.collection("reports").createIndex({ platform: 1, period_start: 1 });
  await db.collection("report_lines").createIndex({ report_id: 1, line_no: 1 }, { unique: true });
}

export async function closeMongo(): Promise<void> {
  await globalForMongo.mongoClient?.close();
  globalForMongo.mongoClient = undefined;
}
