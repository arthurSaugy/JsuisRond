# Cercle Vicieux

Garde ta souris dans le cercle. Le cercle rétrécit, des bombes tombent, le vent souffle, un trou noir aspire, la zone dérive et les contrôles s'inversent. Le dernier dans le cercle gagne.

- **Solo** : survis le plus longtemps possible (record gardé dans le navigateur).
- **Contre des bots** : 1 à 11 bots, niveau facile, normal ou difficile.
- **En ligne** : 2 à 12 joueurs, chacun sur son ordinateur avec sa souris. Des bots peuvent compléter le salon.

## Lancer

Il faut Node.js 18 ou plus.

```bash
npm install
npm start
```

Ouvre <http://localhost:3000>. Le solo et les bots marchent aussi en ouvrant simplement `public/index.html` (pas besoin du serveur).

Pour jouer à plusieurs sur le même réseau, les autres ouvrent `http://<IP-de-ta-machine>:3000`.

Variables d'environnement : `PORT` (3000 par défaut), `HOST` (0.0.0.0 par défaut).

## Jouer en ligne

1. Un joueur clique sur **En ligne → Créer un salon**. Un code de 4 lettres s'affiche.
2. Les autres entrent le code (ou ouvrent le lien copié avec « Copier le lien »).
3. L'hôte choisit les réglages et lance la partie.

Quelqu'un qui arrive pendant une manche la regarde et joue la suivante. Un joueur qui se déconnecte est éliminé sur place.

## Contrôles

- **Clic** dans l'arène : capture la souris. Ta souris déplace ton pion, et les bombes, le vent et le trou noir le poussent : à toi de compenser.
- **Échap** : libère la souris (le solo se met en pause).
- **M** : coupe ou remet le son.
- **Contrôles → Sensibilité** : 1 = un pixel de souris donne un pixel à l'écran.
- **Contrôles → Inertie** : le poids du pion. À 0 % il colle à la souris ; à 50 % (par défaut) il a ~70 ms de retard ; à 100 % ~200 ms, très lourd.
- **Contrôles → Mode curseur libre** : le pion suit ton curseur au lieu de le capturer. Utile si le navigateur refuse la capture (le jeu bascule tout seul dans ce mode après deux refus).

Le pion est une masse tirée par un ressort vers ta souris. Plus tu vas vite, plus tu sens qu'il traîne derrière, mais un geste rapide l'amène quand même plus vite à destination qu'un geste lent. Aucun mouvement de souris n'est perdu.

## Les événements

Tout est annoncé avant d'arriver :

| Événement | Arrive vers | Annonce |
|---|---|---|
| Rétrécissement | 5 s | La future zone s'affiche en pointillés 3,5 s avant, avec un compte à rebours. La bande qui va disparaître clignote en rouge. |
| Bombes | 14 s | Cercle rouge du rayon de l'explosion, qui se remplit jusqu'à l'explosion. Plus on est près du centre, plus on est projeté loin. |
| Vent | 28 s | Grande flèche dans la direction du vent 2,5 s avant, puis des traînées qui soufflent. |
| Trou noir / Répulseur | 42 s | Cercle d'influence en pointillés avec des flèches vers l'intérieur (aspire) ou l'extérieur (repousse). |
| Dérive | 55 s | La zone entière se déplace lentement ; une flèche sur le bord indique où elle va. |
| Inversion | 63 s | Message 3 s avant, puis l'écran se teinte en rose tant que les contrôles sont inversés. |

L'intensité monte pendant environ 2 minutes (plus de bombes, vent plus fort…). Le **rythme** (calme / normal / chaos) avance ou retarde tous ces moments. Chaque événement peut être désactivé dans les réglages.

**Collisions** (option) : les joueurs se bousculent. Celui qui fonce dans l'autre l'envoie valser.

## Mettre en ligne sur un VPS

### Avec Docker

```bash
docker compose up -d --build
```

### Sans Docker (systemd)

```ini
# /etc/systemd/system/cercle-vicieux.service
[Unit]
Description=Cercle Vicieux
After=network.target

[Service]
WorkingDirectory=/opt/cercle-vicieux
ExecStart=/usr/bin/node server.js
Environment=PORT=3000
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now cercle-vicieux
```

### Derrière nginx (HTTPS)

Le WebSocket passe par `/ws` sur le même port que la page. Il faut transmettre l'en-tête `Upgrade` :

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 120s;
}
```

En HTTPS, le client passe automatiquement en `wss://`.

## Comment c'est fait

```
server.js          serveur HTTP (fichiers) + WebSocket (/ws), salons, simulation
public/engine.js   moteur de jeu, partagé entre le navigateur et Node
public/renderer.js rendu Canvas 2D
public/client.js   interface, modes solo/bots/en ligne, souris, sons
```

- **Un seul moteur.** `engine.js` contient toute la logique (zone, événements, physique, collisions, éliminations, IA des bots). En solo il tourne dans le navigateur ; en ligne il tourne sur le serveur.
- **Serveur autoritaire.** Le serveur simule à 60 Hz et envoie l'état à 30 Hz. Les clients n'envoient que leurs mouvements de souris (numérotés).
- **Prédiction côté client.** Ton pion bouge tout de suite : le client applique ses propres mouvements sans attendre le serveur, puis se recale sur chaque état reçu en rejouant les mouvements pas encore confirmés. Les autres joueurs sont affichés environ 100 ms dans le passé et interpolés, pour rester fluides.
- **Visée au ressort.** Côté client, les mouvements de souris s'accumulent dans une cible virtuelle. Le pion la suit comme une masse sur un ressort à amorti critique (résolu exactement, donc stable quel que soit le framerate). Le système est linéaire : le retard est le même en temps à toute vitesse, donc un geste deux fois plus rapide fait aller le pion deux fois plus vite. Le retard en distance (vitesse × délai) n'est perceptible qu'en allant vite, d'où la sensation de force.
- **Garde-fou anti-triche.** Le serveur accorde à chaque joueur un « budget » de déplacement qui se recharge à 3200 unités/s, bien au-dessus d'un geste normal. Il empêche seulement d'envoyer des téléportations.
- **Pointer Lock.** La souris est capturée pour lire ses mouvements relatifs : c'est ce qui permet au jeu de pousser « ta souris ».

### Ajouter un événement

Dans `engine.js` :

1. Ajoute son état dans le constructeur de `Game` (avec un moment de départ `next`).
2. Écris une méthode `updateXxx(t)` avec une phase d'annonce (`warn`) puis active, et appelle-la dans `step()`.
3. Applique son effet dans `externalVel()` (une poussée) ou ailleurs.
4. Expose-le dans `view()`, et ajoute son nom dans `EVENTS`.

Puis dessine l'annonce et l'effet dans `renderer.js`, et ajoute son libellé dans `EVENT_LABELS` (`client.js`).

Dans la console du navigateur, `cercle.session().game` donne accès à la partie en cours (pratique pour tester).
