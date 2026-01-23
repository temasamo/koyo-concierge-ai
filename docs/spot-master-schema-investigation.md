# spot_master スキーマ確認用SQLクエリ

## 1. カラム一覧確認

```sql
-- PostgreSQL/Supabaseの場合
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'spot_master'
ORDER BY ordinal_position;
```

## 2. description / address / sub_category の有無確認

```sql
-- カラム存在確認
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'spot_master'
  AND column_name IN ('description', 'address', 'sub_category');
```

## 3. categoryの実値集計

```sql
SELECT 
  category,
  COUNT(*) as count
FROM spot_master
GROUP BY category
ORDER BY count DESC;
```

## 4. "温泉"カテゴリの存在確認

```sql
-- カテゴリに"温泉"が含まれる行を確認
SELECT 
  id,
  name,
  category
FROM spot_master
WHERE category LIKE '%温泉%'
   OR category = '温泉'
LIMIT 10;

-- カテゴリの一意な値一覧（"温泉"関連を探す）
SELECT DISTINCT category
FROM spot_master
WHERE category IS NOT NULL
ORDER BY category;
```

## 5. tagsの実データ状況

```sql
-- tagsがnullでない行の件数
SELECT COUNT(*) as non_null_tags_count
FROM spot_master
WHERE tags IS NOT NULL;

-- tagsの実データサンプル（nullでない行を10件）
SELECT 
  id,
  name,
  tags,
  LENGTH(tags) as tags_length
FROM spot_master
WHERE tags IS NOT NULL
LIMIT 10;

-- tagsの形式確認（カンマ区切りかJSONか）
SELECT 
  id,
  name,
  tags,
  CASE 
    WHEN tags LIKE '%,%' THEN 'comma_separated'
    WHEN tags LIKE '[%' OR tags LIKE '{%' THEN 'json_or_array'
    ELSE 'other'
  END as tags_format
FROM spot_master
WHERE tags IS NOT NULL
LIMIT 20;
```

## 6. 全カラムのデータ型確認（詳細）

```sql
SELECT 
  column_name,
  data_type,
  character_maximum_length,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_name = 'spot_master'
ORDER BY ordinal_position;
```




