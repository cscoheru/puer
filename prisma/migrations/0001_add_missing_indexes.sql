-- Add missing indexes for query performance optimization
-- Run: psql $DATABASE_URL -f prisma/migrations/0001_add_missing_indexes.sql

-- User: karma is used in ORDER BY for popular users list
CREATE INDEX IF NOT EXISTS users_karma_idx ON users (karma);

-- User: ban_status is used in admin user filtering
CREATE INDEX IF NOT EXISTS users_ban_status_idx ON users (ban_status);

-- User: role is used in admin filtering
CREATE INDEX IF NOT EXISTS users_role_idx ON users (role);

-- Article: author_id used in "my posts" and user profile article queries
CREATE INDEX IF NOT EXISTS articles_author_id_idx ON articles (author_id);

-- Article: status used in listing filters
CREATE INDEX IF NOT EXISTS articles_status_idx ON articles (status);

-- Article: created_at used in pagination ordering
CREATE INDEX IF NOT EXISTS articles_created_at_idx ON articles (created_at);

-- Tea: tasting_note_count used in ORDER BY for tea listing
CREATE INDEX IF NOT EXISTS teas_tasting_note_count_idx ON teas (tasting_note_count);

-- TeaSessionGallery: session_id used in gallery lookups
CREATE INDEX IF NOT EXISTS tea_session_gallery_session_id_idx ON tea_session_gallery (session_id);

-- Favorite: article_id used to count favorites per article
CREATE INDEX IF NOT EXISTS favorites_article_id_idx ON favorites (article_id);
