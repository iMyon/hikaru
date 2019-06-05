FROM ubuntu:bionic

LABEL maintainer="Jiewei Qian <qjw@wacky.one>"

ENV HIKARU_DEFAULT_AMQP="amqp://rabbitmq/" \
    HIKARU_DEFAULT_MONGO="mongodb://mongo/hikaru" \
    TZ="Asia/Shanghai" \
    DEBIAN_FRONTEND="noninteractive" \
    LANG=C.UTF-8 LC_ALL=C.UTF-8

ARG BUILD_PKGS=" \
    build-essential git python tzdata \
    libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    libavcodec-dev libavformat-dev libavdevice-dev libavfilter-dev libavutil-dev libpostproc-dev libswresample-dev libswscale-dev \
"

ARG RUNTIME_PKGS=" \
    curl ffmpeg python3 python3-numpy python3-scipy python3-sklearn python3-matplotlib \
"

USER root
WORKDIR /root/

# copy files what are necessary to build dependency
COPY package.json yarn.lock /hikaru/
COPY posenet/checkpoints.js /hikaru/posenet/

RUN mkdir -p /root/hikaru/ && \
    apt update && \
    apt install --no-install-recommends --no-upgrade -y software-properties-common apt-transport-https curl gpg-agent && \
    add-apt-repository -y ppa:jonathonf/ffmpeg-4 && \
    curl -sL https://deb.nodesource.com/setup_12.x | bash - && \
    curl -sS https://dl.yarnpkg.com/debian/pubkey.gpg | apt-key add - && \
    echo "deb https://dl.yarnpkg.com/debian/ stable main" | tee /etc/apt/sources.list.d/yarn.list && \
    echo ${TZ} > /etc/timezone && \
    apt update && \
    apt install --no-install-recommends --no-upgrade -y ${BUILD_PKGS} ${RUNTIME_PKGS} libjemalloc1 nodejs yarn && \
    cp /usr/share/zoneinfo/${TZ} /etc/_localtime && \
    ( cd /hikaru/ ; yarn install --ignore-optional ) && \
    apt autoremove -y ${BUILD_PKGS} software-properties-common apt-transport-https gpg-agent && \
    apt install --no-install-recommends --no-upgrade -y ${RUNTIME_PKGS} && \
    apt autoremove -y && apt clean -y && \
    mv /etc/_localtime /etc/localtime && \
    mv /hikaru/node_modules/@tensorflow/tfjs-node/deps/lib/libtensorflow.so /lib/libtensorflow.so && \
    ln -s /lib/libtensorflow.so /hikaru/node_modules/@tensorflow/tfjs-node/deps/lib/libtensorflow.so

# prevent memory leak with glibc
ENV LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libjemalloc.so.1

# TODO: make `node_modules/@tensorflow/tfjs-node/deps/lib/libtensorflow.so` a symlink
#       to an easy mount/bind location.
#       this allows host system to inject an optimized tensorflow for better performance

COPY . /hikaru/

ENTRYPOINT ["/hikaru/bin/hikaru"]
