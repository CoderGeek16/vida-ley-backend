-- Ejecutar en phpMyAdmin
CREATE DATABASE IF NOT EXISTS registro_vida_ley
  DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

USE registro_vida_ley;

-- Tabla colaboradores (ya existe, la respetamos con ALTER si falta columna)
CREATE TABLE IF NOT EXISTS colaboradores (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  dni              VARCHAR(8)   NOT NULL UNIQUE,
  apellido_paterno VARCHAR(50)  NOT NULL,
  apellido_materno VARCHAR(50)  NOT NULL,
  nombres          VARCHAR(100) NOT NULL,
  fecha_nacimiento DATE         NOT NULL,
  id_genero        CHAR(2)      NOT NULL,
  fecha_registro   DATETIME     DEFAULT CURRENT_TIMESTAMP,
  pdf_nombre       VARCHAR(200) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Tabla primeros beneficiarios
CREATE TABLE IF NOT EXISTS primeros_beneficiarios (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  id_colaborador   INT          NOT NULL,
  dni              VARCHAR(8)   NOT NULL,
  nombres          VARCHAR(100) NOT NULL,
  apellidos        VARCHAR(100) NOT NULL,
  parentesco       VARCHAR(50)  NOT NULL,
  fecha_nacimiento DATE         NOT NULL,
  domicilio        VARCHAR(250) NOT NULL,
  FOREIGN KEY (id_colaborador) REFERENCES colaboradores(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Tabla segundos beneficiarios
CREATE TABLE IF NOT EXISTS segundos_beneficiarios (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  id_colaborador   INT          NOT NULL,
  dni              VARCHAR(8)   NOT NULL,
  nombres          VARCHAR(100) NOT NULL,
  apellidos        VARCHAR(100) NOT NULL,
  parentesco       VARCHAR(50)  NOT NULL,
  fecha_nacimiento DATE         NOT NULL,
  domicilio        VARCHAR(250) NOT NULL,
  FOREIGN KEY (id_colaborador) REFERENCES colaboradores(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
