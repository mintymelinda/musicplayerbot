let headers = {
  'Client-ID': TWITCH_CLIENT_ID,
  'Authorization': `Bearer ${TWITCH_OAUTH_TOKEN}`,
  'Content-Type': 'application/json'
}

var live = false;
var player;
var session_id;
var videos = {};
var active_prediction_id;
var player;
var playing = false;
var PREDICTION_TIME_WINDOW = 60;
var queries = new Map();

const SONG_REDEMPTION_PROMPT = 'Enter youtube id or song / artist name';
const SONG_REDEMPTION_TITLE = "Add a song request";
const SONG_REDEMPTION_COST = 10;

class CustomRewards {
  constructor(rewards) {
    this.rewards = rewards;
  }

  async createChannelPointRedeems() {
    await fetch('https://api.twitch.tv/helix/channel_points/custom_rewards?' + new URLSearchParams({
      broadcaster_id: BROADCASTER_USER_ID,
      only_manegeable_rewards: true
    }), { headers: headers }
    ).then(r => r.json().then(async response => {
      for (var redeem of response?.data) {
        await fetch('https://api.twitch.tv/helix/channel_points/custom_rewards?' + new URLSearchParams({
          broadcaster_id: BROADCASTER_USER_ID,
          id: redeem.id
        }), { method: 'DELETE', headers: headers });
      }
    }));

    for (var reward of this.rewards) {
      await reward.createChannelPointRedeem();
    }
  }
}

class CustomReward {
  constructor(title, cost, user_input_required, prompt, skip_request_queue, response) {
    this.title = title;
    this.cost = cost;
    this.user_input_required = user_input_required;
    this.prompt = prompt;
    this.skip_request_queue = skip_request_queue;
    this.response = response;
  }

  async createChannelPointRedeem() {
    this.id = await fetch('https://api.twitch.tv/helix/channel_points/custom_rewards?' + new URLSearchParams({
      broadcaster_id: BROADCASTER_USER_ID
    }), {
      method: 'POST',
      body: JSON.stringify({
        title: this.title,
        cost: this.cost,
        is_user_input_required: this.user_input_required,
        prompt: this.prompt,
        should_redemptions_skip_request_queue: this.skip_request_queue
      }),
      headers: headers
    }).then(r => r.json().then(data => data.data[0].id));
  }
}

var custom_rewards = new CustomRewards([
  new CustomReward(SONG_REDEMPTION_TITLE, SONG_REDEMPTION_COST, true, SONG_REDEMPTION_PROMPT, true,
    async (event) => {
      var ytData = queries.get(event.user_input) ?? await searchYouTube(event.user_input);
      queries.set(event.user_input, ytData);
      for (var data of ytData) {
        if (data.isValid()) {
          var videoRequest = new VideoRequest(event, data);
          Object.defineProperty(videos, videoRequest.id, {
            enumerable: true,
            configurable: true,
            value: videoRequest
          });
          break;
        }
      }
    }),
  new CustomReward('Skip Song', 5000, false, undefined, true,
    () => {
      if (playing) {
        if (getVideoList().length > 0) {
          loadNextVideo();
        } else {
          player.stopVideo();
        }
        if (active_prediction_id && active_prediction_id !== -1) {
          patchPrediction(active_prediction_id, 'CANCELED', undefined);
        }
        active_prediction_id = undefined;
      }
    }
  )
]);

class YoutubeData {
  constructor(ytData) {
    this.videoId = ytData.id;
    this.title = ytData.snippet.title;
    this.thumbnail = ytData.snippet.thumbnails.standard;
    this.duration = ytData.snippet.liveBroadcastContent ? undefined : this.YTDurationToSeconds(ytData.contentDetails.duration);
    this.licensedContent = ytData.contentDetails.licensedContent;
    this.viewCount = ytData.statistics.viewCount;
    this.liveBroadcastContent = ytData.snippet.liveBroadcastContent;
    this.categoryId = ytData.snippet.categoryId;
  }

  YTDurationToSeconds(duration) {
    var match = duration.match(/PT(\d+H)?(\d+M)?(\d+S)?/);

    match = match.slice(1).map(function (x) {
      if (x != null) {
        return x.replace(/\D/, '');
      }
    });

    var hours = (parseInt(match[0]) || 0);
    var minutes = (parseInt(match[1]) || 0);
    var seconds = (parseInt(match[2]) || 0);

    return hours * 3600 + minutes * 60 + seconds;
  }

  isValid() {
    return this.viewCount > 1000 && this.liveBroadcastContent === "none";
  }
}

class VideoRequest {
  constructor(event, ytData) {
    this.id = event.id;
    this.rewardId = event.reward.id;
    this.redeemedAt = event.redeemed_at;
    this.ytData = ytData;
  }
}

async function onYouTubeIframeAPIReady() {
  player = new YT.Player('player', {
    height: '1080',
    width: '1920',
    videoId: '',
    playerVars: {
      'autoplay': 0,
      'controls': 0,
      'fs': 0,
      'rel': 0
    },
    events: {
      'onStateChange': onPlayerStateChange
    }
  });
  await custom_rewards.createChannelPointRedeems();
  getWebSocket();
  update();
}

async function subscribeToEvent(type, condition) {
  return await fetch(`https://api.twitch.tv/helix/eventsub/subscriptions`, {
    method: 'POST',
    body: JSON.stringify({
      type: type,
      version: '1',
      condition: condition,
      transport: {
        method: 'websocket',
        session_id: session_id
      }
    }),
    headers: headers
  }).then(r => r.json().then(x => x.data[0].id));
}

async function searchYouTube(query) {
  var results = [];

  var yt = await youtubeQuery(query);
  if (yt) {
    results.push(yt);
  } else {
    var searchRegex = /(youtu.*be.*)\/(watch\?v=|embed\/|v|shorts|)(?<videoId>.*?((?=[&#?])|$))/.exec(query)?.groups['videoId'];
    if (searchRegex) {
      results.push(await youtubeQuery(searchRegex));
    } else {
      for (var key of YOUTUBE_API_KEYS) {
        var search = await fetch(`https://www.googleapis.com/youtube/v3/search?` + new URLSearchParams({
          part: `snippet`,
          q: query,
          type: `video`,
          key: key
        })).then(r => r.json());
        for (var r of search.items) {
          results.push(await youtubeQuery(r.id.videoId));
        }
        if (search.items.length > 0) {
          break;
        }
      }
    }
  }

  return results;
}

async function youtubeQuery(videoId) {
  var data;
  for (var key of YOUTUBE_API_KEYS) {
    var q = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${videoId}&key=${key}`).then(r => r.json());
    if (q?.items?.length > 0) {
      data = new YoutubeData(q.items[0])
      break;
    }
  }
  return data;
}

function onPlayerStateChange(event) {
  if (event.data === YT.PlayerState.ENDED || event.data === YT.PlayerState.STOPPED || event.data === YT.PlayerState.CUED) {
    playing = false;
    live = false;
  }

  if (event.data === YT.PlayerState.PLAYING) {
    playing = true;
  }
}

function getVideoList() {
  return Object.values(videos);
}

// this is the worse thing ever written
function update() {
  if (!live) {
    if (!playing && getVideoList().length > 0 && (active_prediction_id === -1 || !active_prediction_id)) {
      loadNextVideo();
    } else if (!active_prediction_id && playing && getVideoList().length >= 2) {
      var time_remaining = player.getDuration() - player.getCurrentTime();
      if (time_remaining > PREDICTION_TIME_WINDOW) {
        waitForPrediction(time_remaining);
      } else if (!live) {
        for (var v of getVideoList()) {
          time_remaining += v.duration;
          var index = getVideoList().indexOf(v);
          if (time_remaining > PREDICTION_TIME_WINDOW && getVideoList().length - index >= 2) {
            waitForPrediction(time_remaining);
            break;
          }
        }
      }
    }
  }

  setTimeout(() => update(), 900);
}

function loadNextVideo() {
  var video = getVideoList().find(x => x?.playNext) ?? getVideoList()[0];

  console.log(`playNext: ${video.playNext} : ${video.ytData.videoId}`);
  player.loadVideoById(video.ytData.videoId);
  player.playVideo();
  delete videos[video.id];
  live = video.ytData.liveBroadcastContent === "none" ? false : true;
  console.log(videos);
}

function waitForPrediction(duration) {
  active_prediction_id = -1;
  var waitForPrediction = Math.round((duration - PREDICTION_TIME_WINDOW) * 1000);
  console.log(`prediction starting in: ${waitForPrediction / 1000}`);
  setTimeout(() => startPrediction(), waitForPrediction);
}

async function startPrediction() {
  var pollEntries = getVideoList().sort(() => 0.5 - Math.random()).slice(0,10);
  var outcomes = pollEntries.map(v => new Object({ title: v.ytData.title.substring(0, 25) }));

  if (outcomes.length < 2) {
    active_prediction_id = undefined;
    return 'not enough entries';
  }

  fetch('https://api.twitch.tv/helix/predictions', {
    method: 'POST',
    body: JSON.stringify({
      broadcaster_id: BROADCASTER_USER_ID,
      title: 'Vote on the next song!',
      outcomes: outcomes,
      prediction_window: PREDICTION_TIME_WINDOW - 2
    }),
    headers: headers
  }).then(r => r.json().then(data => {
    if (data.data.length > 0) {
      var prediction = data.data[0];
      active_prediction_id = prediction.id;
      for (var i = 0; i < prediction.outcomes.length; i++) {
        Object.defineProperty(pollEntries[i], 'outcome_id', {
          writable: true,
          configurable: true,
          value: prediction.outcomes[i].id
        });

        Object.defineProperty(pollEntries[i], 'prediction_id', {
          writable: true,
          configurable: true,
          value: prediction.id
        });
      }
    }
  })).catch((reason) => {
    console.log(reason);
    active_prediction_id = undefined;
  });
}

function processPredictionLock(event) {
  if (event.id === active_prediction_id) {
    active_prediction_id = undefined;
    var outcomes = event.outcomes;

    outcomes.sort((a, b) => {
      if (a.channel_points === b.channel_points)
        return a.users - b.users;
      else
        return a.channel_points - b.channel_points;
    }).reverse();

    if (outcomes[0].channel_points === 0) {
      patchPrediction(event.id, 'CANCELED');
    } else {
    var winner = outcomes[0].id;
    patchPrediction(event.id, 'RESOLVED', winner);
    var next = getVideoList().find(video => video.outcome_id === winner);
    Object.defineProperty(next, 'playNext', {
      writable: true,
      configurable: true,
      value: true
    });
    }
  }
}

function patchPrediction(id, status, winner) {
  fetch(`https://api.twitch.tv/helix/predictions?` + new URLSearchParams({
    broadcaster_id: BROADCASTER_USER_ID,
    id: id,
    status: status,
    winning_outcome_id: winner
  }), {
    method: 'PATCH',
    headers: headers
  });
}

async function getWebSocket() {
  var ws = new WebSocket("wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30");
  ws.onmessage = async (data) => {
    data = await JSON.parse(data.data.toString());
    switch (data.metadata.message_type) {
      case 'session_welcome':
        session_id = data.payload.session.id;
        for (var redeem of custom_rewards.rewards) {
          subscribeToEvent('channel.channel_points_custom_reward_redemption.add', {
            BROADCASTER_USER_ID: BROADCASTER_USER_ID,
            reward_id: redeem.id
          });
        }
        subscribeToEvent('channel.prediction.lock', { BROADCASTER_USER_ID: BROADCASTER_USER_ID });
        break;
      case 'notification':
        console.log(data);
        switch (data.payload.subscription.type) {
          case 'channel.channel_points_custom_reward_redemption.add':
            var redeem = custom_rewards.rewards.find(x => x.id == data.payload.event.reward.id);
            await redeem?.response(data.payload.event);
            break;
          case 'channel.prediction.lock':
            processPredictionLock(data.payload.event);
            break;
        }
        break;
      case 'session_reconnect':
        console.log('session_reconnect');
        ws.close(200);
        ws = new WebSocket(data.payload.session.reconnect_url);
        break;
    }
  }
}