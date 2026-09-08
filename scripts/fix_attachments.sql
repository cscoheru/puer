-- Remove [附件] placeholder markers from Evernote import
-- These appear as <em style="color:#999">[附件]</em> where en-media tags were stripped

UPDATE articles
SET content = REPLACE(content, '<em style="color:#999">[附件]</em>', '')
WHERE content LIKE '%[附件]%';

UPDATE articles
SET content = REPLACE(content, '<em style="color:#999">[附件: image]</em>', '')
WHERE content LIKE '%[附件: image]%';
