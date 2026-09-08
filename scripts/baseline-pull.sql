SELECT json_agg(row_to_json(t)) FROM (
  SELECT
    a.id            AS draft_id,
    a.title         AS draft_title,
    a.content       AS draft_content,
    a.summary       AS draft_summary,
    a.status        AS draft_status,
    a."createdAt"   AS draft_created,
    a."updatedAt"   AS draft_updated,
    n.id            AS note_id,
    n.title         AS note_title,
    n.content       AS note_content,
    n.summary       AS note_summary,
    n."teaId"       AS "teaId",
    n."authorId"    AS "authorId",
    n.source        AS source,
    n."brewMethod"  AS "brewMethod",
    n."waterTemp"   AS "waterTemp",
    n."teaWeight"   AS "teaWeight",
    n."steepCount"  AS "steepCount",
    n.images        AS images,
    n."videoUrl"    AS "videoUrl",
    n."createdAt"   AS note_created
  FROM articles a
  JOIN tasting_notes n ON n.id = replace(a.id, 'tasting-draft_', '')
  WHERE a.id LIKE 'tasting-draft_%'
  ORDER BY a."createdAt"
) t;
