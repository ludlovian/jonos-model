
----------------------------------------------------------------
--
-- The FTS search tables

create virtual table if not exists searchAlbum
  using fts5(id, text);

----------------------------------------------------------------
--
-- Rebuild sproc
--

create view if not exists rebuildSearch (unused) as select 0  where 0;

create trigger if not exists rebuildSearch_sproc instead of insert on rebuildSearch
begin

  delete from searchAlbum;
  insert into searchAlbum (id, text)
    select
      id,
      concat_ws(' ',
        title,
        artist,
        genre
      )
    from  album;

end;

