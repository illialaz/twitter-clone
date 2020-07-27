const express = require('express')
const path = require('path')
const redis = require('redis')
const bcrypt = require('bcrypt')
const session = require('express-session') 
const client = redis.createClient()
const { promisify } = require('util')
const { formatDistance } = require('date-fns')

const app = express()

const RedisStore = require('connect-redis')(session)
 
app.use(express.urlencoded({ extended: true }))
app.use(
  session({
    store: new RedisStore({ client: client }),
    resave: true,
    saveUninitialized: true,
    cookie: {
      maxAge: 36000000,
      httpOnly: false,
      secure: false,
    },
    secret: 'bM80SARMxlq4fiWhulfNSeUFURWLTY8vyf',
  })
)

app.set('view engine', 'pug')
app.set('views', path.join(__dirname, 'views'))

const ahget2 = (key, field) => new Promise((resolve, reject) => {
  client.hget(key, field, (error, result) => {
    if (error) {
      reject(error)
    } else {
      resolve(result)
    }    
  })  
})

const ahget = promisify(client.hget).bind(client)
const asmembers = promisify(client.smembers).bind(client)
const ahkeys = promisify(client.hkeys).bind(client)
const aincr = promisify(client.incr).bind(client)
const alrange = promisify(client.lrange).bind(client)

const userIdRegExp = new RegExp(/\/id\/(\d+)/);

app.get('/', (req, res) => {
    res.redirect('/login')
})

app.get('/login', (req, res) => {
  res.render('login')
})

app.get(userIdRegExp, async (req, res) => {
  const result = req.url.match(userIdRegExp);

  if (result[1] !== req.session.userid) {
    res.status(403).render('error', { message: 'Unauthorized'});
    return
  }

  const currentUserName = await ahget(`user:${req.session.userid}`, 'username')
  const following = await asmembers(`following:${currentUserName}`)    
  const users = await ahkeys('users')
  
  const timeline = []
  const posts = await alrange(`timeline:${currentUserName}`, 0, 100)

  for (post of posts) {
    const timestamp = await ahget(`post:${post}`, 'timestamp')
    const timeString = formatDistance(
      new Date(),
      new Date(parseInt(timestamp))
    )

    timeline.push({
      message: await ahget(`post:${post}`, 'message'),
      author: await ahget(`post:${post}`, 'username'),
      timeString: timeString,
    })
  }

  res.render('dashboard', {
    users: users.filter(
      (user) => user !== currentUserName && following.indexOf(user) === -1
    ),
    currentUserName,
    timeline
  })
})

app.get('/posts', (req, res) => {
  if (req.session.userid) {
    res.render('post')
  } else {
    res.render('login')
  }
})

app.post('/posts', async (req, res) => {
  if (!req.session.userid) {
    res.render('login')
    return
  }

  const { message } = req.body
  const currentUserName = await ahget(`user:${req.session.userid}`, 'username')
  const postid = await aincr('postid')
  client.hmset(`post:${postid}`, 'userid', req.session.userid, 'username', currentUserName, 'message', message, 'timestamp', Date.now())
  client.lpush(`timeline:${currentUserName}`, postid)

  const followers = await asmembers(`followers:${currentUserName}`)
  for (follower of followers) {
    client.lpush(`timeline:${follower}`, postid)
  }

  res.redirect(`/id/${req.session.userid}`)
})

app.post('/follow', (req, res) => {
  if (!req.session.userid) {
    res.render('login')
    return 
  }

  const { username } = req.body
  
  client.hget(`user:${req.session.userid}`, 'username', (err, currentUserName) => {
    client.sadd(`following:${currentUserName}`, username)
    client.sadd(`followers:${username}`, currentUserName)
  })

  res.redirect(`/id/${req.session.userid}`)
})

app.post('/login', (req, res) => {
  const { username, password } = req.body

  if (!username || !password) {
    res.render('error', { 
      message: 'Please set both username and password' 
    })
    return
  }

  const saveSessionAndRenderDashboard = userid => {
    req.session.userid = userid
    req.session.save()
    res.redirect(`/id/${req.session.userid}`)
  }

  const handleSignup = (username, password) => {
    client.incr('userid', async (err, userid) => {
      client.hset('users', username, userid)

      const saltRounds = 10
      const hash = await bcrypt.hash(password, saltRounds)

      client.hset(`user:${userid}`, 'hash', hash, 'username', username)

      saveSessionAndRenderDashboard(userid)
    })
  }

  const handleLogin = (userid, password) => {
    client.hget(`user:${userid}`, 'hash', async (err, hash) => {
      const result = await bcrypt.compare(password, hash)
      if (result) {
        saveSessionAndRenderDashboard(userid)
      } else {
        res.render('error', {
          message: 'Incorrect password',
        })
        return
      }
    })
  }

  client.hget('users', username, (err, userid) => {
    if (!userid) { //signup procedure
      handleSignup(username, password)
    } else { //login procedure
      handleLogin(userid, password)
    }
  })
})

app.listen(3000, () => console.log('Server ready'))
