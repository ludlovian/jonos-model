----------------------------------------------------------------
--

create view if not exists state as
  with players as (
    select  json_group_object(name, json(state)) as state
      from  playerState
  )
  select  json_object(
            'system', jsonb(a.state),
            'players', jsonb(b.state)
          ) as state
    from  systemState a,
          players b;
