----------------------------------------------------------------
--
create view if not exists systemState as
  with playerStates as (
    select  name,
            jsonb_object(
              'fullName', fullName,
              'uuid', uuid,
              'url', url,
              'model', model
            ) as state
      from  player
  ),
  presets as (
    select json_group_object(name, title) as state
      from preset
  ),
  notifies as (
    select json_group_object(name, title) as state
    from notify
  ),
  players as (
    select json_group_object(name, json(state)) as state
      from playerStates
  )
  select  json_object(
            'version', a.version,
            'started', strftime('%FT%TZ', a.started),
            'listeners', a.listeners,
            'presets', jsonb(c.state),
            'notifies', jsonb(d.state),
            'players', jsonb(b.state)
          ) as state
    from  systemStatus a,
          players b,
          presets c,
          notifies d;

