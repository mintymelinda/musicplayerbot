a = b = c = d = e = f = g = h = i = j = 0
k = 0
  for (let z = 0; z < 10000000; z++) {
    l = [0,1,2,3,4,5,6,7,8,9]
    shuffle(l);
    a += l[0]
    b += l[1]
    c += l[2]
    d += l[3]
    e += l[4]
    f += l[5]
    g += l[6]
    h += l[7]
    i += l[8]
    j += l[9]
    k += 1
  }
  console.log(k, a/k, b/k, c/k, + d/k, + e/k, + f/k, + g/k, + h/k, + i/k, + j/k,)

function shuffle(array) {
  let currentIndex = array.length;

  // While there remain elements to shuffle...
  while (currentIndex != 0) {

    // Pick a remaining element...
    let randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex--;

    // And swap it with the current element.
    [array[currentIndex], array[randomIndex]] = [
      array[randomIndex], array[currentIndex]];
  }
}