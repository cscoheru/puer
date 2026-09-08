INSERT INTO site_daily_stats(date, "totalViews")
VALUES (CURRENT_DATE - INTERVAL '1 day', (SELECT COALESCE(SUM("viewCount"),0) FROM articles))
ON CONFLICT (date) DO UPDATE SET "totalViews" = EXCLUDED."totalViews";
