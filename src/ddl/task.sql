----------------------------------------------------------------
-- Permanent table of transient tasks

create table if not exists task (
  id        integer primary key not null,
  player    integer,
  cmd       text not null,
  p1        any,
  p2        any,
  foreign key (player) references player (id)
);

----------------------------------------------------------------
--
create view if not exists addTask (player, cmd, p1, p2)
  as select 0,0,0,0 where 0;
create trigger if not exists addTask_sproc
  instead of insert on addTask
begin
  insert into task (player, cmd, p1, p2)
    select  a.id, new.cmd, new.p1, new.p2
      from  player a
      where a.name = new.player
        or  a.id = new.player
      limit 1;
end;

----------------------------------------------------------------
--

create view if not exists nextTask as
  select  a.id,
          b.name as player,
          a.cmd,
          a.p1,
          a.p2
    from  task a
    join  player b on b.id = a.player
    order by a.id
    limit 1;

