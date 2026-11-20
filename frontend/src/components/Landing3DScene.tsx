import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';

interface AssetCoreProps {
  label: string;
  color: string;
  position: [number, number, number];
  speed: number;
}

// Pre-allocated vector reused across frames to avoid GC spikes in useFrame.
const POINTER_TARGET = new THREE.Vector3();

const AssetCore: React.FC<AssetCoreProps> = ({ label, color, position, speed }) => {
  const meshRef = useRef<THREE.Mesh>(null);
  const wireRef = useRef<THREE.LineSegments>(null);

  const { geometry, edgesGeo, solidMat, wireMat } = useMemo(() => {
    const geo = new THREE.OctahedronGeometry(0.95, 0);
    const edges = new THREE.EdgesGeometry(geo);
    const mat = new THREE.MeshStandardMaterial({
      color,
      metalness: 0.72,
      roughness: 0.28,
      emissive: color,
      emissiveIntensity: 0.14,
    });
    const wMat = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.65,
    });
    return { geometry: geo, edgesGeo: edges, solidMat: mat, wireMat: wMat };
  }, [color]);

  // Dispose manually allocated GPU resources on unmount to prevent VRAM leaks.
  useEffect(() => {
    return () => {
      geometry.dispose();
      edgesGeo.dispose();
      solidMat.dispose();
      wireMat.dispose();
    };
  }, [geometry, edgesGeo, solidMat, wireMat]);

  useFrame((state, delta) => {
    if (!meshRef.current || !wireRef.current) return;
    const step = Math.min(delta, 0.05);
    meshRef.current.rotation.y += step * speed;
    meshRef.current.rotation.x += step * (speed * 0.45);
    wireRef.current.rotation.copy(meshRef.current.rotation);

    POINTER_TARGET.set(
      position[0] + state.pointer.x * 0.25,
      position[1] + state.pointer.y * 0.18,
      position[2]
    );
    meshRef.current.position.lerp(POINTER_TARGET, 0.06);
    wireRef.current.position.copy(meshRef.current.position);
  });

  return (
    <group>
      <mesh ref={meshRef} position={position} geometry={geometry} material={solidMat} />
      <lineSegments ref={wireRef} position={position} geometry={edgesGeo} material={wireMat} scale={1.14} />
      <Html position={[position[0], position[1] - 1.45, position[2]]} center>
        <div className="px-2 py-0.5 bg-[#121418]/90 border border-[#22262E] text-[11px] font-mono tracking-wider text-[#E6E8EC] whitespace-nowrap">
          {label}
        </div>
      </Html>
    </group>
  );
};

export const Landing3DScene: React.FC = () => {
  const [lowPower, setLowPower] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const check = () => setLowPower(media.matches || window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  return (
    <div className="w-full h-[360px] md:h-[420px] terminal-card rounded overflow-hidden relative">
      <Canvas
        dpr={lowPower ? 1 : [1, 1.5]}
        frameloop={lowPower ? 'demand' : 'always'}
        camera={{ position: [0, 0.3, 6.2], fov: 42 }}
        gl={{ antialias: !lowPower, powerPreference: 'high-performance' }}
      >
        <color attach="background" args={['#0A0B0D']} />
        <ambientLight intensity={0.45} />
        <directionalLight position={[5, 6, 5]} intensity={1.1} color="#FFFFFF" />
        <pointLight position={[-5, -3, 4]} intensity={0.6} color="#D4AF37" />

        <AssetCore label="BTCUSDT" color="#F7931A" position={[-2.5, 0.1, 0]} speed={0.45} />
        <AssetCore label="ETHUSDT" color="#3B82F6" position={[0, 0.25, 0.3]} speed={0.55} />
        <AssetCore label="XAUUSDT" color="#D4AF37" position={[2.5, 0.1, 0]} speed={0.4} />
      </Canvas>
    </div>
  );
};
