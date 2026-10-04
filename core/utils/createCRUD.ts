// deno-lint-ignore-file no-explicit-any ban-ts-comment
import { TRouter } from "@/core/http/router.ts";
import z from "zod";
import { bodyAsJson, paramsAsJson, queryAsJson } from "@/core/http/utils.ts";
import {
  ClientSession,
  Collection,
  DeleteResult,
  ObjectId,
  UpdateResult,
  WithId,
} from "mongodb";
import { parseDate } from "chrono-node";
import { Response } from "@/core/http/response.ts";
import { mongodb } from "@/database.ts";
import { deepObjectToFlatten } from "@/core/utils/objectUtils.ts";

export type TCrudDetails<T extends z.ZodObject> = {
  router: TRouter & {
    metadata?: Record<string, unknown>;
  };
  schema: T;
  model: Collection<z.output<T>>;
  insertSchema?: z.ZodObject;
  updateSchema?: z.ZodObject;
};

export type TCrudIsolation<T> = (
  req: Request,
  action: "create" | "get" | "update" | "del" | "count",
) =>
  | {
    [K in keyof T]?: unknown;
  }
  | Promise<
    {
      [K in keyof T]?: unknown;
    }
  >;

export type TCrudProjection<T> =
  & {
    [K in keyof T]?: number;
  }
  & {
    [K in string]?: number;
  };

export type TCrudOptions<T extends z.ZodObject, D = z.output<T>> = {
  disable?: {
    create?: boolean;
    get?: boolean;
    count?: boolean;
    update?: boolean;
    del?: boolean;
  };
  projection?: TCrudProjection<D> | Array<TCrudProjection<D>>;
  isolationFields?: TCrudIsolation<D>;
  hooks?: {
    beforeCreate?: (opts: {
      data: D & { _id?: ObjectId };
      session?: ClientSession;
    }, req: Request) => D | void | Promise<D | void>;
    afterCreate?: (
      opts: { data: WithId<D>; session?: ClientSession },
      req: Request,
    ) => void | Promise<void>;
    beforeUpdate?: (
      opts: { _id: ObjectId; data: Partial<D>; session?: ClientSession },
      req: Request,
    ) => Partial<D> | void | Promise<Partial<D> | void>;
    afterUpdate?: (
      opts: {
        _id: ObjectId;
        results: UpdateResult<Partial<D>>;
        data: Partial<D>;
        session?: ClientSession;
      },
      req: Request,
    ) => void | Promise<void>;
    beforeDel?: (
      opts: { _id: ObjectId; session?: ClientSession },
      req: Request,
    ) => void | Promise<void>;
    afterDel?: (
      opts: { _id: ObjectId; results: DeleteResult; session?: ClientSession },
      req: Request,
    ) => void | Promise<void>;
  };
};

const resolveJSONSchemaType = (ctx: {
  zodSchema: z.z.core.$ZodTypes;
  jsonSchema: z.z.core.JSONSchema.BaseSchema;
  path: (string | number)[];
}) => {
  if (ctx.zodSchema instanceof z.ZodDate) {
    ctx.jsonSchema.type = "string";
    ctx.jsonSchema.format = "date-time";
  }
};

export const $objectId = z.preprocess((val) => {
  if (val instanceof ObjectId) return val;

  if (typeof val === "string" && ObjectId.isValid(val)) {
    return new ObjectId(val);
  }

  return val;
}, z.instanceof(ObjectId)).meta({ tsType: "string" });

const emptyArray: any[] = [];

export const paginatedAggregation = (
  query: z.infer<typeof paginationSchema>,
) => [
  ...(query.filters
    ? [{
      $match: normalizeFilters(query.filters),
    }]
    : emptyArray),
  ...(query.subFilters
    ? [{
      $match: normalizeFilters(query.subFilters),
    }]
    : emptyArray),
  ...(query.sort ? [{ $sort: query.sort }] : emptyArray),
  ...(query.offset ? [{ $skip: query.offset }] : emptyArray),
  ...(query.limit ? [{ $limit: query.limit }] : emptyArray),
  ...(query.project ? [{ $project: query.project }] : emptyArray),
];

export const createCRUD = <T extends z.ZodObject>(
  details: TCrudDetails<T>,
  opts?: TCrudOptions<T>,
) => {
  details.router.metadata = {
    crud: {
      schema: details.schema.toJSONSchema({
        io: "output",
        unrepresentable: "any",
        override: resolveJSONSchemaType,
      }),
      insertSchema: details.insertSchema?.toJSONSchema({
        io: "input",
        unrepresentable: "any",
        override: resolveJSONSchemaType,
      }),
      updateSchema: details.updateSchema?.toJSONSchema({
        io: "input",
        unrepresentable: "any",
        override: resolveJSONSchemaType,
      }),
    },
    ...details.router.metadata,
  };

  if (!opts?.disable?.create) {
    details.router.post("/", function create() {
      const $body = details.insertSchema ?? details.schema;
      const $return = z.object({
        _id: z.string(),
      });

      return {
        shape: () => ({
          body: $body,
          return: $return,
        }),
        handler: async (req: Request) => {
          const body = $body.parse(await bodyAsJson(req)) as any;

          const exec = async (session?: ClientSession) => {
            const data = (await opts?.hooks?.beforeCreate?.(
              { data: body, session },
              req,
            )) ?? body;

            const dataToInsert = details.schema.parse({
              ...data,
              ...(await opts?.isolationFields?.(req, "create")),
            }) as any;

            const { insertedId } = await details.model.insertOne(
              dataToInsert,
              { session },
            );

            await opts?.hooks?.afterCreate?.({
              data: { _id: insertedId, ...data },
              session,
            }, req);

            return { insertedId };
          };

          const { insertedId } =
            (opts?.hooks?.beforeCreate || opts?.hooks?.afterCreate)
              ? await mongodb.withSession((_) => _.withTransaction(exec))
              : await exec();

          return Response.json({
            _id: insertedId.toString(),
          });
        },
      };
    });
  }

  if (!opts?.disable?.count) {
    details.router.get("/count", function count() {
      const $query = paginationSchema.pick({
        filters: true,
        subFilters: true,
      });
      const $return = z.object({
        count: z.number(),
      });

      return {
        shape: () => ({
          query: $query,
          return: $return,
        }),
        handler: async (req: Request) => {
          const query = $query.parse(queryAsJson(req));

          const count = await details.model.countDocuments({
            ...(query.filters ? normalizeFilters(query.filters) : {}),
            ...(query.subFilters ? normalizeFilters(query.subFilters) : {}),
            ...(await opts?.isolationFields?.(req, "count") as any),
          });

          return Response.json({ count } satisfies z.output<typeof $return>);
        },
      };
    });
  }

  if (!opts?.disable?.get) {
    details.router.get("{/:id}", function get() {
      const $params = z.object({
        id: z.string().optional(),
      });
      const $query = paginationSchema;
      const $return = z.object({
        results: z.array(details.schema.extend({
          _id: z.string(),
        })),
      });

      return {
        shape: () => ({
          params: $params,
          query: $query,
          return: $return,
        }),
        handler: async (req: Request) => {
          const params = $params.parse(paramsAsJson(req));
          const query = $query.parse(queryAsJson(req));

          const resultsQuery = details.model.aggregate([
            {
              $match: {
                ...(params.id ? { _id: new ObjectId(params.id) } : {}),
                ...(await opts?.isolationFields?.(req, "get")),
              } as any,
            },
            ...(opts?.projection
              ? Array.isArray(opts.projection)
                ? opts.projection.map(($project) => ({ $project }))
                : [{ $project: opts.projection }]
              : emptyArray),
            ...paginatedAggregation(query),
          ]);

          return Response.json(
            {
              results: await resultsQuery.toArray(),
            },
          );
        },
      };
    });
  }

  const $params = z.object({
    id: z.string(),
  });

  if (!opts?.disable?.update) {
    details.router.patch("/:id", function update() {
      const $body =
        (details.updateSchema ?? details.insertSchema ?? details.schema)
          .partial();

      return {
        shape: () => ({
          params: $params,
          body: $body,
        }),
        handler: async (req: Request) => {
          const params = $params.parse(paramsAsJson(req));
          const body = $body.parse(await bodyAsJson(req));

          const _id = new ObjectId(params.id);

          const exec = async (session?: ClientSession) => {
            const $set: any = await opts?.hooks?.beforeUpdate?.({
              _id,
              data: body as any,
              session,
            }, req) ?? body;

            $set.updatedAt = new Date();

            const results = await details.model.updateOne(
              {
                _id,
                ...(await opts?.isolationFields?.(req, "update")),
              } as any,
              {
                $set,
              },
              {
                session,
              },
            );

            if (opts?.hooks?.afterUpdate) {
              await opts.hooks.afterUpdate({
                _id,
                results,
                data: $set,
                session,
              }, req);
            } else if (!results.modifiedCount) {
              throw new Error("No record updated!", { cause: results });
            }
          };

          (opts?.hooks?.beforeUpdate || opts?.hooks?.afterUpdate)
            ? await mongodb.withSession((_) => _.withTransaction(exec))
            : await exec();

          return Response.ok();
        },
      };
    });
  }

  if (!opts?.disable?.del) {
    details.router.del("/:id", function del() {
      return {
        shape: () => ({
          params: $params,
        }),
        handler: async (req: Request) => {
          const params = $params.parse(paramsAsJson(req));

          const _id = new ObjectId(params.id);

          const exec = async (session?: ClientSession) => {
            await opts?.hooks?.beforeDel?.({ _id, session }, req);

            const results = await details.model.deleteOne({
              _id,
              ...(await opts?.isolationFields?.(req, "del")),
            } as any, { session });

            if (opts?.hooks?.afterDel) {
              await opts.hooks.afterDel({
                _id,
                results,
                session,
              }, req);
            } else if (!results.deletedCount) {
              throw new Error("No record deleted!", { cause: results });
            }
          };

          (opts?.hooks?.beforeDel || opts?.hooks?.afterDel)
            ? await mongodb.withSession((_) => _.withTransaction(exec))
            : await exec();

          return Response.ok();
        },
      };
    });
  }
};

export const clientValueSchema = z.union([
  z.object({
    type: z.enum(
      [
        "string",
        "number",
        "boolean",
        "objectId",
        "date",
        "regex",
        "null",
      ],
    ),
    value: z.string(),
    options: z.object({
      regexFlags: z.string().optional(),
    }).optional(),
  }),
  z.string(),
]).meta({ tsLabel: "TFilterValue" });

export const $clientValue = clientValueSchema;

export const expressionSchema = z.object({
  $exists: clientValueSchema,
  $eq: clientValueSchema,
  $ne: clientValueSchema,
  $gt: clientValueSchema,
  $gte: clientValueSchema,
  $lt: clientValueSchema,
  $lte: clientValueSchema,
  $mod: z.tuple([z.number(), z.number()]),
  $regex: clientValueSchema,
  $in: z.array(clientValueSchema),
  $nin: z.array(clientValueSchema),
  $all: z.array(clientValueSchema),
}).partial().meta({ tsLabel: "TFilterExpression" });

export const $expression = expressionSchema;

export const basicFilterSchema = z.record(
  z.string(),
  z.union([z.object({ $not: expressionSchema }), expressionSchema]),
).meta({ tsLabel: "TBasicFilter" });

export const $basicFilter = basicFilterSchema;

export const multiFilterSchema = z.object({
  $and: z.array(basicFilterSchema),
  $or: z.array(basicFilterSchema),
}).partial().meta({ tsLabel: "TMultiFilters" });

export const $multiFilter = multiFilterSchema;

export const filtersSchema = z.union([basicFilterSchema, multiFilterSchema])
  .meta({ tsLabel: "TFilters" });

export const $filter = filtersSchema;

export const paginationSchema = z.object(
  {
    filters: filtersSchema.optional().describe("Client side filters"),
    subFilters: filtersSchema.optional().describe(
      "Client side sub-filters (Just a second layer of filters)",
    ),
    offset: z.coerce.number().min(0).default(0),
    limit: z.coerce.number().min(1).max(2000).default(2000),
    sort: z.record(z.string(), z.coerce.number().min(-1).max(1)).default({
      _id: -1,
    })
      .describe(
        "Provide a sorting information in mongodb sort object format",
      ),
    project: z.record(
      z.string(),
      z.union([
        z.coerce.number().min(0).max(1),
        z.object({
          $slice: z.union([
            z.coerce.number(),
            z.tuple([z.coerce.number(), z.coerce.number()]),
          ]),
        }),
      ]),
    ).optional()
      .describe(
        "Provide a projection information in mongodb project object format",
      ),
  },
).meta({ tsLabel: "TPagination" });

export const $pagination = paginationSchema;

const MAX_FILTER_PATTERN_LENGTH = 200;

export const normalizeFilterExpression = (
  value?: string | number | boolean | z.output<typeof clientValueSchema>,
) => {
  if (typeof value === "object" && typeof value.type === "string") {
    switch (value.type) {
      case "boolean":
        return ["true", "1"].includes(value.value);

      case "date":
        return value.value.startsWith("nldate:")
          ? parseDate(value.value.replace(/^nldate:/, ""))
          : new Date(value.value);

      case "number":
        return Number(value.value);

      case "objectId":
        return new ObjectId(value.value);

      case "regex":
        // Bounded because the pattern comes from the client and is run both
        // here and by mongod. A length cap only raises the cost of a
        // catastrophically backtracking pattern; it does not remove it.
        if (value.value.length > MAX_FILTER_PATTERN_LENGTH) {
          throw Response.badRequest(
            `A filter pattern may not exceed ${MAX_FILTER_PATTERN_LENGTH} characters!`,
          );
        }

        return new RegExp(value.value, value.options?.regexFlags);

      case "null":
        return null;

      default:
        return value.value;
    }
  }

  return value;
};

export const normalizeFilters = (
  filters?: z.output<typeof filtersSchema>,
) => {
  if (typeof filters !== "object" || !filters) return {};

  const transform = (
    expr:
      | { $not: z.output<typeof expressionSchema> }
      | z.output<typeof expressionSchema>,
  ) => {
    const newExpr: Record<string, any> = {};

    for (const [key, value] of Object.entries(expr)) {
      if (key === "$not") newExpr[key] = transform(value);
      else {
        newExpr[key] = value instanceof Array
          ? value.map(normalizeFilterExpression)
          : normalizeFilterExpression(value);
      }
    }

    return newExpr;
  };

  const newFilters: Record<string, any> = {};

  for (const [key, expr] of Object.entries(filters)) {
    if (["$and", "$or"].includes(key)) {
      newFilters[key] = expr.map(normalizeFilters);
      continue;
    }

    newFilters[key] = transform(expr);
  }

  return newFilters;
};

export const testFilters = <T extends Record<string, unknown>>(
  filters: z.output<typeof filtersSchema> | string,
  deepData: T,
) => {
  const data = deepObjectToFlatten(deepData);
  const validatedFilters = typeof filters === "string"
    ? JSON.parse(filters) as z.output<typeof filtersSchema>
    : filters;

  const testExpression = (
    expressions: z.output<typeof expressionSchema>,
    key: string,
  ) => {
    let success = true;

    for (const [operator, expression] of Object.entries(expressions)) {
      if (!success) break;

      const exists = key in data;
      const value = data[key];

      try {
        if (Array.isArray(expression)) {
          const targets = expression.map(normalizeFilterExpression).map(String);

          // Arrays survive flattening intact, so compare element by element.
          // Passing one through String() yields "a,b" and matched nothing,
          // which quietly broke every rule written against an array field.
          const actual = (Array.isArray(value) ? value : [value]).map(String);

          switch (operator) {
            case "$in":
              success = actual.some((item) => targets.includes(item));
              break;
            case "$nin":
              success = !actual.some((item) => targets.includes(item));
              break;
            case "$all":
              // Mongo's $all holds when every target is present. This was
              // negated, so it held precisely when they were not.
              success = targets.every((target) => actual.includes(target));
              break;

            default:
              success = false;
              break;
          }
        } else {
          const target = normalizeFilterExpression(expression);

          switch (operator) {
            case "$exists":
              success = exists === Boolean(target);
              break;
            case "$eq":
              success = String(value) === String(target);
              break;
            case "$ne":
              success = String(value) !== String(target);
              break;
            case "$gt":
              // @ts-ignore
              success = value > target;
              break;
            case "$gte":
              // @ts-ignore
              success = value >= target;
              break;
            case "$lt":
              // @ts-ignore
              success = value < target;
              break;
            case "$lte":
              // @ts-ignore
              success = value <= target;
              break;
            case "$mod":
              // @ts-ignore
              success = value % target[0] === target[1];
              break;
            case "$regex":
              // @ts-ignore
              success = RegExp(target).test(value);
              break;

            default:
              success = false;
              break;
          }
        }
      } catch {
        success = false;
      }
    }

    return success;
  };

  const testBasicFilters = (
    basicFilters: z.output<typeof basicFilterSchema>,
  ) => {
    let success = true;

    for (const [key, expression] of Object.entries(basicFilters)) {
      if (!success) break;

      if ("$not" in expression) {
        success = !testExpression(expression["$not"], key);

        continue;
      }

      success = testExpression(expression, key);
    }

    return success;
  };

  let pass = true;

  if ("$and" in validatedFilters && Array.isArray(validatedFilters["$and"])) {
    for (const filters of validatedFilters["$and"]) {
      const success = testFilters(filters, data);

      if (!success) {
        pass = false;

        break;
      }
    }
  }

  if (!pass) return false;

  if ("$or" in validatedFilters && Array.isArray(validatedFilters["$or"])) {
    for (const filters of validatedFilters["$or"]) {
      const success = testFilters(filters, data);

      if (success) return true;
    }

    return false;
  }

  if (!("$and" in validatedFilters) && !("$or" in validatedFilters)) {
    return testBasicFilters(
      validatedFilters as z.output<typeof basicFilterSchema>,
    );
  }

  return false;
};
